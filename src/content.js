(() => {
  const DEFAULT_SETTINGS = { enabled: true, strictness: 30, previewMode: true };
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
  let classifyTimer = null;
  let generation = 0;
  const cardsByVideoId = new Map();
  const metadataQueue = new Map();
  const pendingIds = new Set();
  const scoreByVideoId = new Map();

  void initialize();

  async function initialize() {
    settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      if (changes.enabled) settings.enabled = changes.enabled.newValue;
      if (changes.strictness) settings.strictness = changes.strictness.newValue;
      if (changes.previewMode) settings.previewMode = changes.previewMode.newValue;

      if (!settings.enabled || isShortsPage()) {
        revealAllCards();
        removeAllBadges();
        removePageNotice();
        updateBlockedCount();
        return;
      }

      reapplyKnownScores();
      scheduleScan(0);
    });

    document.addEventListener("yt-navigate-finish", resetForNavigation);

    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_PAGE_STATS") return false;
      sendResponse(getPageStats());
      return false;
    });

    scheduleScan(0);
  }

  function resetForNavigation() {
    generation += 1;
    window.clearTimeout(scanTimer);
    window.clearTimeout(classifyTimer);
    scanTimer = null;
    classifyTimer = null;
    metadataQueue.clear();
    pendingIds.clear();
    scoreByVideoId.clear();
    cardsByVideoId.clear();
    revealAllCards();
    removeAllBadges();
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
      const metadata = readVideoMetadata(card);
      if (!metadata) continue;

      const previousId = card.dataset.slopshieldVideoId;
      if (previousId && previousId !== metadata.videoId) {
        cardsByVideoId.get(previousId)?.delete(card);
        card.classList.remove(HIDDEN_CLASS);
      }

      card.dataset.slopshieldVideoId = metadata.videoId;
      addCard(metadata.videoId, card);

      if (scoreByVideoId.has(metadata.videoId)) {
        applyScore(card, scoreByVideoId.get(metadata.videoId));
      } else if (!pendingIds.has(metadata.videoId)) {
        metadataQueue.set(metadata.videoId, metadata);
      }
    }

    if (metadataQueue.size > 0) scheduleClassification();
  }

  function scheduleClassification() {
    if (classifyTimer !== null) return;
    classifyTimer = window.setTimeout(() => {
      classifyTimer = null;
      void flushClassificationQueue();
    }, 220);
  }

  async function flushClassificationQueue() {
    if (!settings.enabled || metadataQueue.size === 0) return;

    const requestGeneration = generation;
    const batch = [...metadataQueue.values()].slice(0, 50);
    for (const video of batch) {
      metadataQueue.delete(video.videoId);
      pendingIds.add(video.videoId);
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CLASSIFY_VIDEOS",
        videos: batch,
      });

      if (requestGeneration !== generation) return;
      if (!response?.ok) throw new Error(response?.error || "Classification failed");

      for (const result of response.results) {
        if (typeof result?.videoId !== "string" || !Number.isFinite(result?.slopScore)) {
          continue;
        }

        const score = clamp(result.slopScore, 0, 1);
        scoreByVideoId.set(result.videoId, score);
        for (const card of cardsByVideoId.get(result.videoId) ?? []) {
          applyScore(card, score);
        }
      }

      await chrome.storage.local.set({ lastApiError: null });
      removePageNotice();
      updateBlockedCount();
    } catch (error) {
      await chrome.storage.local.set({ lastApiError: error.message });
      showPageNotice("SlopShield cannot reach the mock API at localhost:8787");
      window.setTimeout(() => {
        for (const video of batch) metadataQueue.set(video.videoId, video);
        scheduleClassification();
      }, 4000);
    } finally {
      for (const video of batch) pendingIds.delete(video.videoId);
      if (metadataQueue.size > 0) scheduleClassification();
    }
  }

  function readVideoMetadata(card) {
    if (card.closest("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]")) {
      return null;
    }

    const anchor = card.querySelector('a[href^="/watch?v="], a[href*="youtube.com/watch?v="]');
    if (!anchor) return null;

    const url = new URL(anchor.href, location.origin);
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;

    const titleNode = card.querySelector(
      "#video-title, #video-title-link, a.yt-lockup-metadata-view-model__title",
    );
    const channelNode = card.querySelector(
      'ytd-channel-name a, #channel-name a, #metadata a, yt-content-metadata-view-model a[href^="/@"]',
    );

    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      title: cleanText(titleNode?.getAttribute("title") || titleNode?.textContent),
      channel: cleanText(channelNode?.textContent),
    };
  }

  function addCard(videoId, card) {
    if (!cardsByVideoId.has(videoId)) cardsByVideoId.set(videoId, new Set());
    cardsByVideoId.get(videoId).add(card);
  }

  function applyScore(card, score) {
    const isFlagged = score >= threshold();
    const shouldHide = settings.enabled && !settings.previewMode && !isShortsPage() && isFlagged;
    card.classList.toggle(HIDDEN_CLASS, shouldHide);
    card.dataset.slopshieldScore = score.toFixed(4);
    card.dataset.slopshieldVerdict = isFlagged ? "flag" : "allow";

    if (settings.previewMode && settings.enabled && !isShortsPage()) {
      renderScoreBadge(card, score, isFlagged);
    } else {
      removeScoreBadge(card);
    }
  }

  function reapplyKnownScores() {
    for (const [videoId, score] of scoreByVideoId) {
      for (const card of cardsByVideoId.get(videoId) ?? []) applyScore(card, score);
    }
    updateBlockedCount();
  }

  function revealAllCards() {
    for (const card of document.querySelectorAll(`.${HIDDEN_CLASS}`)) {
      card.classList.remove(HIDDEN_CLASS);
    }
  }

  function renderScoreBadge(card, score, isFlagged) {
    const host = card.querySelector("ytd-thumbnail, yt-thumbnail-view-model") || card;
    host.classList.add("slopshield-badge-host");

    let badge = host.querySelector(":scope > .slopshield-score-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "slopshield-score-badge";
      badge.setAttribute("aria-label", "SlopShield mock classification");
      host.append(badge);
    }

    badge.dataset.verdict = isFlagged ? "flag" : "allow";
    badge.textContent = `MOCK ${Math.round(score * 100)}% · ${isFlagged ? "FLAG" : "ALLOW"}`;
  }

  function removeScoreBadge(card) {
    const badge = card.querySelector(".slopshield-score-badge");
    const host = badge?.parentElement;
    badge?.remove();
    host?.classList.remove("slopshield-badge-host");
  }

  function removeAllBadges() {
    for (const badge of document.querySelectorAll(".slopshield-score-badge")) {
      badge.parentElement?.classList.remove("slopshield-badge-host");
      badge.remove();
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

    void chrome.storage.local.set({
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
      if (card.dataset.slopshieldVerdict === "flag") flaggedVideoIds.add(videoId);
    }

    return {
      flaggedCount: flaggedVideoIds.size,
      scannedCount: scannedVideoIds.size,
    };
  }

  function threshold() {
    return 1 - clamp(Number(settings.strictness), 0, 100) / 100;
  }

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
})();
