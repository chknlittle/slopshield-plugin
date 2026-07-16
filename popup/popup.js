const DEFAULT_SETTINGS = { enabled: true, strictness: 30, previewMode: true };

const enabledInput = document.querySelector("#enabled");
const strictnessInput = document.querySelector("#strictness");
const strictnessValue = document.querySelector("#strictnessValue");
const previewModeInput = document.querySelector("#previewMode");
const blockedCount = document.querySelector("#blockedCount");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const latency = document.querySelector("#latency");

let statusRefreshTimer = null;
let statsRefreshTimer = null;

void initialize();

async function initialize() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  enabledInput.checked = settings.enabled;
  strictnessInput.value = settings.strictness;
  previewModeInput.checked = settings.previewMode;
  renderStrictness(settings.strictness);
  renderCount(0);

  enabledInput.addEventListener("change", async () => {
    await chrome.storage.sync.set({ enabled: enabledInput.checked });
  });

  strictnessInput.addEventListener("input", () => {
    renderStrictness(strictnessInput.value);
  });

  strictnessInput.addEventListener("change", async () => {
    await chrome.storage.sync.set({ strictness: Number(strictnessInput.value) });
  });

  previewModeInput.addEventListener("change", async () => {
    await chrome.storage.sync.set({ previewMode: previewModeInput.checked });
  });

  await Promise.all([refreshHealth(), refreshPageStats()]);
  statusRefreshTimer = window.setInterval(refreshHealth, 5000);
  statsRefreshTimer = window.setInterval(refreshPageStats, 1000);

  window.addEventListener("pagehide", () => {
    window.clearInterval(statusRefreshTimer);
    window.clearInterval(statsRefreshTimer);
  }, { once: true });
}

async function refreshHealth() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "HEALTH_CHECK" });
    if (!result?.ok) throw new Error(result?.error || "Unavailable");

    statusDot.className = "status-dot online";
    statusText.textContent = result.mode === "mock" ? "Mock engine online" : "Detection API online";
    latency.textContent = `${result.latencyMs}ms`;
  } catch {
    statusDot.className = "status-dot offline";
    statusText.textContent = "Start the mock server";
    latency.textContent = "offline";
  }
}

async function refreshPageStats() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error("No active tab");

    const result = await chrome.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_STATS" });
    renderCount(result?.flaggedCount ?? 0);
  } catch {
    renderCount(0);
  }
}

function renderStrictness(value) {
  const normalized = Math.min(100, Math.max(0, Number(value) || 0));
  strictnessValue.value = String(normalized).padStart(2, "0");
  strictnessInput.style.setProperty("--fill", `${normalized}%`);
}

function renderCount(value) {
  blockedCount.textContent = String(Math.max(0, Number(value) || 0)).padStart(2, "0");
}
