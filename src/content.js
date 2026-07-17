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

  let settings = { ...DEFAULT_SETTINGS };
  let scanTimer = null;
  let analysisTimer = null;
  let generation = 0;
  const cardsByVideoId = new Map();
  const analysisQueue = new Map();
  const pendingIds = new Set();
  const classificationByVideoId = new Map();

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
    pendingIds.clear();
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
      } else if (!pendingIds.has(video.videoId)) {
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
      if (!response?.ok) throw new Error(response?.error || "Analysis failed");

      for (let index = 0; index < batch.length; index += 1) {
        const video = batch[index];
        const result = response.results[index];
        if (result?.status === "completed" && typeof result.isAi === "boolean") {
          saveClassification(video.videoId, result.isAi);
          continue;
        }
        if (result?.status === "failed") {
          saveClassification(video.videoId, false);
          continue;
        }

        analysisQueue.set(video.videoId, video);
        retryDelay = 2_000;
      }

      await extensionApi.storage.local.set({ lastApiError: null });
      removePageNotice();
      updateBlockedCount();
    } catch (error) {
      await extensionApi.storage.local.set({ lastApiError: error.message });
      showPageNotice("SlopShield cannot reach the API at localhost:3000");
      for (const video of batch) analysisQueue.set(video.videoId, video);
      retryDelay = 4_000;
    } finally {
      for (const video of batch) pendingIds.delete(video.videoId);
      if (analysisQueue.size > 0) scheduleAnalysis(retryDelay ?? 220);
    }
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
