(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DEFAULT_SETTINGS = { enabled: true };
  const CARD_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "yt-lockup-view-model",
  ].join(",");
  const HIDDEN_CLASS = "slopshield-hidden";
  const STATUS_BADGE_CLASS = "slopshield-status-badge";
  const TRANSCRIPT_REQUEST = "SLOPSHIELD_TRANSCRIPT_REQUEST";
  const TRANSCRIPT_RESPONSE = "SLOPSHIELD_TRANSCRIPT_RESPONSE";
  const TRANSCRIPT_CONCURRENCY = 1;
  const TRANSCRIPT_MIN_INTERVAL_MS = 1_000;
  const TRANSCRIPT_BACKOFF_BASE_MS = 30_000;
  const TRANSCRIPT_BACKOFF_MAX_MS = 5 * 60_000;

  let settings = { ...DEFAULT_SETTINGS };
  let scanTimer = null;
  let analysisTimer = null;
  let transcriptTimer = null;
  let generation = 0;
  let transcriptInFlight = 0;
  let transcriptNextStartAt = 0;
  let transcriptFailureStreak = 0;
  const cardsByVideoId = new Map();
  const analysisQueue = new Map();
  const transcriptQueue = new Map();
  const pendingIds = new Set();
  const transcriptPendingIds = new Set();
  const transcriptRetryIds = new Set();
  const transcriptFailures = new Map();
  const transcriptNeededVideos = new Map();
  const classificationByVideoId = new Map();
  const failedVideoIds = new Set();
  const transcriptRequests = new Map();
  const observedCards = new WeakSet();
  const viewportObserver = new IntersectionObserver(handleViewportChanges, { threshold: 0.01 });

  window.addEventListener("message", receiveTranscriptResponse);
  void initialize();

  async function initialize() {
    settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);

    extensionApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes.enabled) return;
      settings.enabled = changes.enabled.newValue;

      if (!settings.enabled || isShortsPage()) {
        revealAllCards();
        removePageNotice();
        reapplyKnownClassifications();
        clearUnknownCardStatuses();
        return;
      }

      reapplyKnownClassifications();
      scheduleScan(0);
    });

    document.addEventListener("yt-navigate-finish", resetForNavigation);
    new MutationObserver(() => scheduleScan())
      .observe(document.documentElement, { childList: true, subtree: true });

    extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_PAGE_STATS") return false;
      sendResponse(getPageStats());
      return false;
    });

    scheduleScan(0);
  }

  function resetForNavigation() {
    generation += 1;
    window.clearTimeout(scanTimer);
    window.clearTimeout(analysisTimer);
    window.clearTimeout(transcriptTimer);
    scanTimer = null;
    analysisTimer = null;
    transcriptTimer = null;
    analysisQueue.clear();
    transcriptQueue.clear();
    pendingIds.clear();
    transcriptPendingIds.clear();
    transcriptRetryIds.clear();
    transcriptFailures.clear();
    transcriptNeededVideos.clear();
    classificationByVideoId.clear();
    failedVideoIds.clear();
    cardsByVideoId.clear();
    revealAllCards();
    clearAllCardStatuses();
    scheduleScan(0);
  }

  function scheduleScan(delay = 180) {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanPage();
    }, delay);
  }

  function scanPage() {
    if (!settings.enabled || isShortsPage()) return;

    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const video = readVideo(card);
      if (video === null) continue;

      const previousId = card.dataset.slopshieldVideoId;
      if (previousId && previousId !== video.videoId) {
        cardsByVideoId.get(previousId)?.delete(card);
        card.classList.remove(HIDDEN_CLASS);
      }

      card.dataset.slopshieldVideoId = video.videoId;
      addCard(video.videoId, card);

      if (classificationByVideoId.has(video.videoId)) {
        applyClassification(card, classificationByVideoId.get(video.videoId));
      } else if (failedVideoIds.has(video.videoId)) {
        setCardStatus(card, null);
      } else {
        setCardStatus(card, "processing");
        if (transcriptNeededVideos.has(video.videoId)) {
          if (isCardInViewport(card)) enqueueTranscript(video);
        } else if (
          !pendingIds.has(video.videoId) &&
          !transcriptPendingIds.has(video.videoId) &&
          !transcriptRetryIds.has(video.videoId)
        ) {
          analysisQueue.set(video.videoId, video);
        }
      }
    }

    if (analysisQueue.size > 0) scheduleAnalysis();
  }

  function scheduleAnalysis(delay = 220) {
    if (analysisTimer !== null) return;
    analysisTimer = window.setTimeout(() => {
      analysisTimer = null;
      void flushAnalysisQueue();
    }, delay);
  }

  async function flushAnalysisQueue() {
    if (!settings.enabled || analysisQueue.size === 0) return;

    const requestGeneration = generation;
    const batch = [...analysisQueue.values()].slice(0, 50);
    for (const video of batch) {
      analysisQueue.delete(video.videoId);
      pendingIds.add(video.videoId);
    }

    let retryDelay = null;
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ANALYZE_VIDEOS", videos: batch });
      if (requestGeneration !== generation) return;
      if (!response?.ok) throw new Error(response?.error || "Analysis lookup failed");

      for (let index = 0; index < batch.length; index += 1) {
        const video = batch[index];
        const result = response.results[index];
        if (result?.status === "completed" && typeof result.isAi === "boolean") {
          saveClassification(video.videoId, result.isAi);
        } else if (result?.status === "missing" && result.needsTranscript === true) {
          markTranscriptNeeded(video);
        } else if (result?.status === "failed") {
          markFailed(video.videoId);
        } else {
          analysisQueue.set(video.videoId, video);
          retryDelay = 3_000;
        }
      }

      removePageNotice();
    } catch (error) {
      showPageNotice("SlopShield cannot reach its API");
      for (const video of batch) analysisQueue.set(video.videoId, video);
      retryDelay = 5_000;
    } finally {
      for (const video of batch) pendingIds.delete(video.videoId);
      if (analysisQueue.size > 0) scheduleAnalysis(retryDelay ?? 220);
    }
  }

  function markTranscriptNeeded(video) {
    transcriptNeededVideos.set(video.videoId, video);
    for (const card of cardsByVideoId.get(video.videoId) ?? []) {
      if (isCardInViewport(card)) {
        enqueueTranscript(video);
        break;
      }
    }
  }

  function handleViewportChanges(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = transcriptNeededVideos.get(entry.target.dataset.slopshieldVideoId);
      if (video) enqueueTranscript(video);
    }
  }

  function isCardInViewport(card) {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function enqueueTranscript(video) {
    if (
      classificationByVideoId.has(video.videoId) ||
      transcriptPendingIds.has(video.videoId) ||
      transcriptRetryIds.has(video.videoId)
    ) return;
    transcriptQueue.set(video.videoId, video);
    transcriptPendingIds.add(video.videoId);
    pumpTranscriptQueue();
  }

  function pumpTranscriptQueue() {
    if (
      !settings.enabled ||
      transcriptInFlight >= TRANSCRIPT_CONCURRENCY ||
      transcriptQueue.size === 0 ||
      transcriptTimer !== null
    ) return;

    const delay = Math.max(0, transcriptNextStartAt - Date.now());
    if (delay > 0) {
      transcriptTimer = window.setTimeout(() => {
        transcriptTimer = null;
        pumpTranscriptQueue();
      }, delay);
      return;
    }

    const [videoId, video] = transcriptQueue.entries().next().value;
    transcriptQueue.delete(videoId);
    transcriptInFlight += 1;
    transcriptNextStartAt = Date.now() + TRANSCRIPT_MIN_INTERVAL_MS;
    void fetchAndSubmitTranscript(video, generation).finally(() => {
      transcriptInFlight -= 1;
      transcriptPendingIds.delete(videoId);
      pumpTranscriptQueue();
    });
  }

  async function fetchAndSubmitTranscript(video, requestGeneration) {
    let transcriptFetched = false;
    try {
      const transcript = await requestTranscript(video.videoId);
      transcriptFetched = true;
      transcriptFailureStreak = 0;
      transcriptFailures.delete(video.videoId);
      if (requestGeneration !== generation) return;

      const response = await extensionApi.runtime.sendMessage({
        type: "ANALYZE_VIDEOS",
        videos: [{ ...video, transcript: transcript.transcript }],
      });
      if (requestGeneration !== generation) return;
      if (!response?.ok) throw new Error(response?.error || "Transcript submission failed");

      // The API now owns the transcript even when analysis remains queued.
      transcriptNeededVideos.delete(video.videoId);
      const result = response.results[0];
      if (result?.status === "completed" && typeof result.isAi === "boolean") {
        saveClassification(video.videoId, result.isAi);
      } else if (result?.status === "failed") {
        markFailed(video.videoId);
      } else {
        analysisQueue.set(video.videoId, video);
        scheduleAnalysis(3_000);
      }
    } catch (error) {
      const retryable = error?.retryable !== false;
      const failures = (transcriptFailures.get(video.videoId) ?? 0) + 1;
      transcriptFailures.set(video.videoId, failures);

      if (!transcriptFetched && retryable) applyTranscriptBackoff();

      if (retryable && failures < 3 && requestGeneration === generation) {
        console.debug(`SlopShield will retry transcript ${video.videoId} (attempt ${failures})`);
        transcriptRetryIds.add(video.videoId);
        window.setTimeout(() => {
          if (requestGeneration !== generation || classificationByVideoId.has(video.videoId)) return;
          transcriptRetryIds.delete(video.videoId);
          enqueueTranscript(video);
        }, 2_000 * failures);
      } else {
        console.warn(`SlopShield could not fetch transcript ${video.videoId}; leaving it visible:`, error);
        transcriptFailures.delete(video.videoId);
        markFailed(video.videoId);
      }
    }
  }

  function applyTranscriptBackoff() {
    transcriptFailureStreak += 1;
    const exponentialDelay = Math.min(
      TRANSCRIPT_BACKOFF_MAX_MS,
      TRANSCRIPT_BACKOFF_BASE_MS * 2 ** (transcriptFailureStreak - 1),
    );
    const jitteredDelay = exponentialDelay * (0.8 + Math.random() * 0.4);
    transcriptNextStartAt = Math.max(transcriptNextStartAt, Date.now() + jitteredDelay);
  }

  async function requestTranscript(videoId) {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        transcriptRequests.delete(requestId);
        reject(new Error("YouTube transcript request timed out"));
      }, 30_000);

      transcriptRequests.set(requestId, {
        resolve: (result) => {
          window.clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      });
      window.postMessage({ type: TRANSCRIPT_REQUEST, requestId, videoId }, "*");
    });
  }

  function receiveTranscriptResponse(event) {
    if (event.source !== window || event.data?.type !== TRANSCRIPT_RESPONSE) return;
    const pending = transcriptRequests.get(event.data.requestId);
    if (!pending) return;
    transcriptRequests.delete(event.data.requestId);

    if (event.data.ok) {
      pending.resolve(event.data);
    } else {
      const error = new Error(event.data.error || "YouTube transcript request failed");
      error.retryable = event.data.retryable !== false;
      pending.reject(error);
    }
  }

  function saveClassification(videoId, isAi) {
    transcriptNeededVideos.delete(videoId);
    failedVideoIds.delete(videoId);
    classificationByVideoId.set(videoId, isAi);
    for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, isAi);
  }

  function markFailed(videoId) {
    transcriptNeededVideos.delete(videoId);
    classificationByVideoId.delete(videoId);
    failedVideoIds.add(videoId);
    for (const card of cardsByVideoId.get(videoId) ?? []) {
      card.classList.remove(HIDDEN_CLASS);
      setCardStatus(card, null);
    }
  }

  function readVideo(card) {
    if (card.closest("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]")) return null;

    const anchor = card.querySelector('a[href^="/watch?v="], a[href*="youtube.com/watch?v="]');
    if (!anchor) return null;

    const url = new URL(anchor.href, location.origin);
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;

    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  function addCard(videoId, card) {
    if (!cardsByVideoId.has(videoId)) cardsByVideoId.set(videoId, new Set());
    cardsByVideoId.get(videoId).add(card);
    if (!observedCards.has(card)) {
      observedCards.add(card);
      viewportObserver.observe(card);
    }
  }

  function applyClassification(card, isAi) {
    const shouldHide = settings.enabled && !isShortsPage() && isAi;
    card.classList.toggle(HIDDEN_CLASS, shouldHide);
    setCardStatus(card, isAi ? (shouldHide ? null : "would-hide") : "verified");
  }

  function setCardStatus(card, status) {
    const thumbnail = card.querySelector("ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail");
    if (!thumbnail) return;

    let badge = [...thumbnail.children].find((child) => child.classList?.contains(STATUS_BADGE_CLASS));
    if (!status) {
      badge?.remove();
      thumbnail.classList.remove("slopshield-thumbnail");
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = STATUS_BADGE_CLASS;
      thumbnail.append(badge);
    }
    thumbnail.classList.add("slopshield-thumbnail");
    badge.dataset.status = status;
    badge.textContent = status === "verified"
      ? "✓ Verified"
      : status === "would-hide"
        ? "AI detected"
        : "Checking…";
  }

  function clearUnknownCardStatuses() {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = card.dataset.slopshieldVideoId;
      if (!classificationByVideoId.has(videoId)) setCardStatus(card, null);
    }
  }

  function clearAllCardStatuses() {
    for (const badge of document.querySelectorAll(`.${STATUS_BADGE_CLASS}`)) badge.remove();
    for (const thumbnail of document.querySelectorAll(".slopshield-thumbnail")) {
      thumbnail.classList.remove("slopshield-thumbnail");
    }
  }

  function reapplyKnownClassifications() {
    for (const [videoId, isAi] of classificationByVideoId) {
      for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, isAi);
    }
  }

  function revealAllCards() {
    for (const card of document.querySelectorAll(`.${HIDDEN_CLASS}`)) {
      card.classList.remove(HIDDEN_CLASS);
    }
  }

  function showPageNotice(message) {
    let notice = document.querySelector(".slopshield-page-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "slopshield-page-notice";
      document.documentElement.append(notice);
    }
    notice.textContent = message;
  }

  function removePageNotice() {
    document.querySelector(".slopshield-page-notice")?.remove();
  }

  function getPageStats() {
    const flaggedVideoIds = new Set();

    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = card.dataset.slopshieldVideoId;
      if (videoId && card.classList.contains(HIDDEN_CLASS)) {
        flaggedVideoIds.add(videoId);
      }
    }

    return { flaggedCount: flaggedVideoIds.size };
  }

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }
})();
