const extensionApi = globalThis.browser ?? globalThis.chrome;
const DEFAULT_SETTINGS = { enabled: true };

const enabledInput = document.querySelector("#enabled");
const blockedCount = document.querySelector("#blockedCount");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const latency = document.querySelector("#latency");

void initialize();

async function initialize() {
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  enabledInput.checked = settings.enabled;
  enabledInput.addEventListener("change", async () => {
    await extensionApi.storage.sync.set({ enabled: enabledInput.checked });
  });

  await Promise.all([refreshHealth(), refreshPageStats()]);
}

async function refreshHealth() {
  try {
    const health = await extensionApi.runtime.sendMessage({ type: "HEALTH_CHECK" });
    if (!health?.ok) throw new Error(health?.error || "Unavailable");

    statusDot.className = health.engineReachable ? "status-dot online" : "status-dot offline";
    statusText.textContent = health.engineReachable
      ? `Engine ${health.engineVersion} online`
      : "API online · engine unavailable";
    latency.textContent = `${health.latencyMs}ms`;
  } catch {
    statusDot.className = "status-dot offline";
    statusText.textContent = "SlopShield API offline";
    latency.textContent = "offline";
  }
}

async function refreshPageStats() {
  try {
    const [activeTab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error("No active tab");

    const stats = await extensionApi.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_STATS" });
    renderCount(stats?.flaggedCount ?? 0);
  } catch {
    renderCount(0);
  }
}

function renderCount(value) {
  blockedCount.textContent = String(Math.max(0, Number(value) || 0)).padStart(2, "0");
}
