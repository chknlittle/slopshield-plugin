const API_BASE_URL = "https://slopshield-api.chkn.computer";
const DEFAULT_SETTINGS = Object.freeze({ enabled: true });

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ANALYZE_VIDEOS") {
    analyzeVideos(message.videos)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "HEALTH_CHECK") {
    checkHealth()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function analyzeVideos(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return { ok: true, results: [] };

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.enabled) return { ok: true, results: [] };

  const batch = videos.slice(0, 100);
  const response = await fetch(`${API_BASE_URL}/v1/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: batch.map((video) => video.url) }),
  });

  if (!response.ok) throw new Error(`SlopShield API returned HTTP ${response.status}`);

  const payload = await response.json();
  if (!Array.isArray(payload.analyses)) {
    throw new Error("SlopShield API response is missing analyses");
  }

  return {
    ok: true,
    results: payload.analyses.map((analysis, index) => ({
      videoId: batch[index]?.videoId,
      status: analysis.status,
      isAi: analysis.is_ai,
      error: analysis.error,
    })),
  };
}

async function checkHealth() {
  const startedAt = performance.now();
  const response = await fetch(`${API_BASE_URL}/health`);

  if (!response.ok) throw new Error(`SlopShield API returned HTTP ${response.status}`);

  const health = await response.json();
  return {
    ok: health.ok === true,
    engineReachable: health.engine?.reachable === true,
    engineVersion: health.engine?.version ?? "unknown",
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
