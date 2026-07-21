(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const helpers = globalThis.__slopShieldHelpers;
  const DEFAULT_SETTINGS = { enabled: true };
  const CARD_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "yt-lockup-view-model",
  ].join(",");
  const HIDDEN_CLASS = "slopshield-hidden";
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const STATUS_BADGE_CLASS = "slopshield-status-badge";
  const TRANSCRIPT_REQUEST = "SLOPSHIELD_TRANSCRIPT_REQUEST";
  const TRANSCRIPT_RESPONSE = "SLOPSHIELD_TRANSCRIPT_RESPONSE";
  const CHANNELS_UPDATED = "SLOPSHIELD_CHANNELS_UPDATED";
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
  let lastScanMs = 0;
  let maxScanMs = 0;
  let scanCount = 0;
  const cardsByVideoId = new Map();
  const videoById = new Map();
  const analysisQueue = new Map();
  const transcriptQueue = new Map();
  const pendingIds = new Set();
  const transcriptPendingIds = new Set();
  const transcriptRetryIds = new Set();
  const transcriptFailures = new Map();
  const transcriptNeededVideos = new Map();
  const classificationByVideoId = new Map();
  const failedVideoIds = new Map();
  const viewportDeferredIds = new Set();
  const transcriptRequests = new Map();
  const observedCards = new WeakSet();
  const viewportObserver = new IntersectionObserver(handleViewportChanges, { threshold: 0.01 });

  window.addEventListener("message", receivePageMessage);
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
    new MutationObserver((mutations) => {
      const pageChanged = mutations.some((mutation) => {
        const target = mutation.target instanceof Element
          ? mutation.target
          : mutation.target.parentElement;
        return !target?.closest(`.${STATUS_BADGE_CLASS}, .slopshield-page-notice`);
      });
      if (pageChanged) scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });

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
    viewportDeferredIds.clear();
    cardsByVideoId.clear();
    videoById.clear();
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
    const scanStartedAt = performance.now();

    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const discoveredVideo = readVideo(card);
      if (discoveredVideo === null) continue;
      const video = rememberVideo(discoveredVideo);

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
        setCardStatus(card, failedVideoIds.get(video.videoId));
      } else {
        setCardStatus(card, "processing");
        if (!video.channelId) {
          if (video.channelUnavailable) setCardStatus(card, "unavailable");
          continue;
        }
        if (transcriptNeededVideos.has(video.videoId)) {
          if (isCardInViewport(card)) enqueueTranscript(video);
        } else if (viewportDeferredIds.has(video.videoId)) {
          if (isCardInViewport(card)) {
            viewportDeferredIds.delete(video.videoId);
            analysisQueue.set(video.videoId, video);
          }
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
    lastScanMs = performance.now() - scanStartedAt;
    maxScanMs = Math.max(maxScanMs, lastScanMs);
    scanCount += 1;
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
    const batch = [...analysisQueue.values()]
      .sort((left, right) => Number(isVideoInViewport(right.videoId)) - Number(isVideoInViewport(left.videoId)))
      .slice(0, 50)
      .map((video) => ({ ...video, evidenceCandidate: isVideoInViewport(video.videoId) }));
    for (const video of batch) {
      analysisQueue.delete(video.videoId);
      pendingIds.add(video.videoId);
    }

    let retryDelay = null;
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ANALYZE_VIDEOS", videos: batch });
      if (requestGeneration !== generation) return;
      if (!response?.ok) throw new Error(response?.error || "Analysis lookup failed");
      const resultsByVideoId = helpers.indexAnalysisResults(response.results);

      for (const video of batch) {
        const result = resultsByVideoId.get(video.videoId);
        if (result?.status === "completed" && typeof result.isAi === "boolean") {
          saveClassification(video.videoId, result.isAi, result.classificationSource);
        } else if (result?.status === "missing" && result.needsTranscript === true) {
          markTranscriptNeeded(video);
        } else if (result?.status === "failed" && result.classificationSource === "channel") {
          if (isVideoInViewport(video.videoId)) {
            analysisQueue.set(video.videoId, video);
            retryDelay = 10_000;
          } else {
            viewportDeferredIds.add(video.videoId);
          }
        } else if (result?.status === "failed") {
          markFailed(video.videoId, "check-failed");
        } else if (
          (result?.status === "queued" || result?.status === "running") &&
          !isVideoInViewport(video.videoId)
        ) {
          viewportDeferredIds.add(video.videoId);
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
      const videoId = entry.target.dataset.slopshieldVideoId;
      const transcriptVideo = transcriptNeededVideos.get(videoId);
      if (transcriptVideo) {
        enqueueTranscript(transcriptVideo);
        continue;
      }
      const video = videoById.get(videoId);
      if (
        video?.channelId &&
        !classificationByVideoId.has(videoId) &&
        !failedVideoIds.has(videoId) &&
        !pendingIds.has(videoId)
      ) {
        viewportDeferredIds.delete(videoId);
        analysisQueue.set(videoId, video);
        scheduleAnalysis(0);
      }
    }
  }

  function isCardInViewport(card) {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function isVideoInViewport(videoId) {
    for (const card of cardsByVideoId.get(videoId) ?? []) {
      if (isCardInViewport(card)) return true;
    }
    return false;
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
      const result = helpers.indexAnalysisResults(response.results).get(video.videoId);
      if (result?.status === "completed" && typeof result.isAi === "boolean") {
        saveClassification(video.videoId, result.isAi, result.classificationSource);
      } else if (result?.status === "failed") {
        markFailed(video.videoId, "check-failed");
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
        markFailed(video.videoId, retryable ? "check-failed" : "unavailable");
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

  function receivePageMessage(event) {
    if (event.source !== window) return;
    if (event.data?.type === CHANNELS_UPDATED) {
      scheduleScan(0);
      return;
    }
    if (event.data?.type !== TRANSCRIPT_RESPONSE) return;
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

  function saveClassification(videoId, isAi, source) {
    transcriptNeededVideos.delete(videoId);
    viewportDeferredIds.delete(videoId);
    failedVideoIds.delete(videoId);
    const classification = { isAi, source: source === "channel" ? "channel" : "video" };
    classificationByVideoId.set(videoId, classification);
    for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, classification);
  }

  function markFailed(videoId, status = "check-failed") {
    transcriptNeededVideos.delete(videoId);
    viewportDeferredIds.delete(videoId);
    classificationByVideoId.delete(videoId);
    failedVideoIds.set(videoId, status);
    for (const card of cardsByVideoId.get(videoId) ?? []) {
      card.classList.remove(HIDDEN_CLASS);
      setCardStatus(card, status);
    }
  }

  function readVideo(card) {
    if (card.closest("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]")) return null;

    const anchor = card.querySelector('a[href^="/watch?v="], a[href*="youtube.com/watch?v="]');
    if (!anchor) return null;

    const url = new URL(anchor.href, location.origin);
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;

    const known = videoById.get(videoId);
    const annotation = readChannelAnnotation(card, videoId);
    return {
      videoId,
      channelId: known?.channelId ?? annotation.channelId,
      channelUnavailable: known?.channelId ? false : known?.channelUnavailable ?? annotation.unavailable,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  function rememberVideo(discovered) {
    const existing = videoById.get(discovered.videoId);
    if (!existing) {
      videoById.set(discovered.videoId, discovered);
      return discovered;
    }
    if (!existing.channelId && discovered.channelId) {
      const enriched = { ...existing, channelId: discovered.channelId, channelUnavailable: false };
      videoById.set(discovered.videoId, enriched);
      return enriched;
    }
    if (!existing.channelId && !existing.channelUnavailable && discovered.channelUnavailable) {
      const unavailable = { ...existing, channelUnavailable: true };
      videoById.set(discovered.videoId, unavailable);
      return unavailable;
    }
    if (existing.channelId && discovered.channelId && existing.channelId !== discovered.channelId) {
      console.warn(`SlopShield found conflicting channel IDs for ${discovered.videoId}`);
    }
    return existing;
  }

  function readChannelAnnotation(card, videoId) {
    const outer = card.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer");
    for (const element of [card, outer]) {
      if (!element || element.dataset.slopshieldChannelVideoId !== videoId) continue;
      const channelId = element.dataset.slopshieldChannelId;
      if (CHANNEL_ID.test(channelId ?? "")) return { channelId, unavailable: false };
      if (element.dataset.slopshieldChannelUnavailable === "true") {
        return { channelId: null, unavailable: true };
      }
    }
    return { channelId: null, unavailable: false };
  }

  function addCard(videoId, card) {
    if (!cardsByVideoId.has(videoId)) cardsByVideoId.set(videoId, new Set());
    cardsByVideoId.get(videoId).add(card);
    if (!observedCards.has(card)) {
      observedCards.add(card);
      viewportObserver.observe(card);
    }
  }

  function applyClassification(card, classification) {
    const shouldHide = settings.enabled && !isShortsPage() && classification.isAi;
    card.classList.toggle(HIDDEN_CLASS, shouldHide);
    const inherited = classification.source === "channel";
    setCardStatus(
      card,
      classification.isAi
        ? (shouldHide ? null : inherited ? "would-hide-channel" : "would-hide")
        : inherited ? "verified-channel" : "verified",
    );
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
    const text = status === "verified" || status === "verified-channel"
      ? "✓ No AI detected"
      : status === "would-hide-channel"
        ? "AI channel"
        : status === "would-hide"
          ? "AI detected"
          : status === "unavailable"
            ? "Unavailable"
            : status === "check-failed"
              ? "Check failed"
              : "Checking…";

    if (badge.dataset.status !== status) badge.dataset.status = status;
    if (badge.textContent !== text) badge.textContent = text;
  }

  function clearUnknownCardStatuses() {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = card.dataset.slopshieldVideoId;
      if (classificationByVideoId.has(videoId)) continue;
      if (failedVideoIds.has(videoId)) {
        setCardStatus(card, failedVideoIds.get(videoId));
      } else if (videoById.get(videoId)?.channelUnavailable) {
        setCardStatus(card, "unavailable");
      } else {
        setCardStatus(card, null);
      }
    }
  }

  function clearAllCardStatuses() {
    for (const badge of document.querySelectorAll(`.${STATUS_BADGE_CLASS}`)) badge.remove();
    for (const thumbnail of document.querySelectorAll(".slopshield-thumbnail")) {
      thumbnail.classList.remove("slopshield-thumbnail");
    }
  }

  function reapplyKnownClassifications() {
    for (const [videoId, classification] of classificationByVideoId) {
      for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, classification);
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
    const videoIds = new Set();
    const hiddenVideoIds = new Set();

    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = card.dataset.slopshieldVideoId;
      if (!videoId) continue;
      videoIds.add(videoId);
      if (card.classList.contains(HIDDEN_CLASS)) hiddenVideoIds.add(videoId);
    }

    return {
      ...helpers.summarizeVideoStates({
        videoIds,
        classifications: classificationByVideoId,
        failures: failedVideoIds,
        hiddenVideoIds,
      }),
      lastScanMs: Math.round(lastScanMs * 10) / 10,
      maxScanMs: Math.round(maxScanMs * 10) / 10,
      scanCount,
    };
  }

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }
})();
