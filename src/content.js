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
  const TRANSCRIPT_REQUEST = "SLOPSHIELD_TRANSCRIPT_REQUEST";
  const TRANSCRIPT_RESPONSE = "SLOPSHIELD_TRANSCRIPT_RESPONSE";
  const TRANSCRIPT_CONCURRENCY = 2;

  let settings = { ...DEFAULT_SETTINGS };
  let scanTimer = null;
  let analysisTimer = null;
  let generation = 0;
  let transcriptInFlight = 0;
  const cardsByVideoId = new Map();
  const analysisQueue = new Map();
  const transcriptQueue = new Map();
  const pendingIds = new Set();
  const transcriptPendingIds = new Set();
  const transcriptRetryIds = new Set();
  const transcriptFailures = new Map();
  const classificationByVideoId = new Map();
  const transcriptRequests = new Map();
  const bridgeReady = Promise.resolve();

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
        updateBlockedCount();
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
    scanTimer = null;
    analysisTimer = null;
    analysisQueue.clear();
    transcriptQueue.clear();
    pendingIds.clear();
    transcriptPendingIds.clear();
    transcriptRetryIds.clear();
    transcriptFailures.clear();
    classificationByVideoId.clear();
    cardsByVideoId.clear();
    revealAllCards();
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
      } else if (
        !pendingIds.has(video.videoId) &&
        !transcriptPendingIds.has(video.videoId) &&
        !transcriptRetryIds.has(video.videoId)
      ) {
        analysisQueue.set(video.videoId, video);
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
          enqueueTranscript(video);
        } else if (result?.status === "failed") {
          saveClassification(video.videoId, false);
        } else {
          analysisQueue.set(video.videoId, video);
          retryDelay = 3_000;
        }
      }

      await extensionApi.storage.local.set({ lastApiError: null });
      removePageNotice();
      updateBlockedCount();
    } catch (error) {
      await extensionApi.storage.local.set({ lastApiError: error.message });
      showPageNotice("SlopShield cannot reach its API");
      for (const video of batch) analysisQueue.set(video.videoId, video);
      retryDelay = 5_000;
    } finally {
      for (const video of batch) pendingIds.delete(video.videoId);
      if (analysisQueue.size > 0) scheduleAnalysis(retryDelay ?? 220);
    }
  }

  function enqueueTranscript(video) {
    if (classificationByVideoId.has(video.videoId) || transcriptPendingIds.has(video.videoId)) return;
    transcriptQueue.set(video.videoId, video);
    transcriptPendingIds.add(video.videoId);
    pumpTranscriptQueue();
  }

  function pumpTranscriptQueue() {
    while (settings.enabled && transcriptInFlight < TRANSCRIPT_CONCURRENCY && transcriptQueue.size > 0) {
      const [videoId, video] = transcriptQueue.entries().next().value;
      transcriptQueue.delete(videoId);
      transcriptInFlight += 1;
      void fetchAndSubmitTranscript(video, generation).finally(() => {
        transcriptInFlight -= 1;
        transcriptPendingIds.delete(videoId);
        pumpTranscriptQueue();
      });
    }
  }

  async function fetchAndSubmitTranscript(video, requestGeneration) {
    try {
      const transcript = await requestTranscript(video.videoId);
      transcriptFailures.delete(video.videoId);
      if (requestGeneration !== generation) return;

      const response = await extensionApi.runtime.sendMessage({
        type: "ANALYZE_VIDEOS",
        videos: [{ ...video, transcript: transcript.transcript }],
      });
      if (requestGeneration !== generation) return;
      if (!response?.ok) throw new Error(response?.error || "Transcript submission failed");

      const result = response.results[0];
      if (result?.status === "completed" && typeof result.isAi === "boolean") {
        saveClassification(video.videoId, result.isAi);
      } else if (result?.status === "failed") {
        saveClassification(video.videoId, false);
      } else {
        analysisQueue.set(video.videoId, video);
        scheduleAnalysis(3_000);
      }
    } catch (error) {
      const failures = (transcriptFailures.get(video.videoId) ?? 0) + 1;
      transcriptFailures.set(video.videoId, failures);
      console.warn(
        `SlopShield transcript attempt ${failures} failed for ${video.videoId}:`,
        error,
      );

      if (failures < 3 && requestGeneration === generation) {
        transcriptRetryIds.add(video.videoId);
        window.setTimeout(() => {
          if (requestGeneration !== generation || classificationByVideoId.has(video.videoId)) return;
          transcriptRetryIds.delete(video.videoId);
          enqueueTranscript(video);
        }, 2_000 * failures);
      } else {
        transcriptFailures.delete(video.videoId);
        saveClassification(video.videoId, false);
      }
    }
  }

  async function requestTranscript(videoId) {
    await bridgeReady;
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

    if (event.data.ok) pending.resolve(event.data);
    else pending.reject(new Error(event.data.error || "YouTube transcript request failed"));
  }

  function saveClassification(videoId, isAi) {
    classificationByVideoId.set(videoId, isAi);
    for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, isAi);
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
  }

  function applyClassification(card, isAi) {
    card.classList.toggle(HIDDEN_CLASS, settings.enabled && !isShortsPage() && isAi);
  }

  function reapplyKnownClassifications() {
    for (const [videoId, isAi] of classificationByVideoId) {
      for (const card of cardsByVideoId.get(videoId) ?? []) applyClassification(card, isAi);
    }
    updateBlockedCount();
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

  function updateBlockedCount() {
    const { flaggedCount } = getPageStats();
    void extensionApi.storage.local.set({
      lastScanAt: Date.now(),
      lastPageFlaggedCount: flaggedCount,
    });
  }

  function getPageStats() {
    const flaggedVideoIds = new Set();
    const scannedVideoIds = new Set();

    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = card.dataset.slopshieldVideoId;
      if (!videoId) continue;
      scannedVideoIds.add(videoId);
      if (card.classList.contains(HIDDEN_CLASS)) flaggedVideoIds.add(videoId);
    }

    return {
      flaggedCount: flaggedVideoIds.size,
      scannedCount: scannedVideoIds.size,
    };
  }

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }
})();
