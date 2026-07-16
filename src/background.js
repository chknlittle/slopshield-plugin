const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  strictness: 30,
  previewMode: true,
  apiBaseUrl: "http://localhost:8787",
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CLASSIFY_VIDEOS") {
    classifyVideos(message.videos)
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

async function classifyVideos(videos) {
  if (!Array.isArray(videos) || videos.length === 0) {
    return { ok: true, results: [] };
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.enabled) {
    return { ok: true, results: [] };
  }

  const strictness = clamp(Number(settings.strictness), 0, 100);
  const threshold = 1 - strictness / 100;
  const response = await fetch(`${normalizeBaseUrl(settings.apiBaseUrl)}/v1/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: { name: "slopshield-extension", version: "0.3.0" },
      strictness,
      threshold,
      videos: videos.slice(0, 100),
    }),
  });

  if (!response.ok) {
    throw new Error(`Classification API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.results)) {
    throw new Error("Classification API response is missing results");
  }

  await chrome.storage.local.set({ lastApiError: null });
  return { ok: true, results: payload.results };
}

async function checkHealth() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const startedAt = performance.now();
  const response = await fetch(`${normalizeBaseUrl(settings.apiBaseUrl)}/health`);

  if (!response.ok) {
    throw new Error(`Mock server returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return {
    ok: payload.status === "ok",
    mode: payload.mode ?? "unknown",
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/+$/, "");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
