const form = document.querySelector("#config-form");
const saveMessage = document.querySelector("#save-message");
const statusGrid = document.querySelector("#status-grid");
const refreshStatusButton = document.querySelector("#refresh-status");
const reloadConfigButton = document.querySelector("#reload-config");

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function setMessage(text, tone = "muted") {
  saveMessage.textContent = text;
  saveMessage.dataset.tone = tone;
}

function populateForm(config) {
  document.querySelector("#wsUrl").value = config.wsUrl || "";
  document.querySelector("#hostId").value = config.host?.id || "";
  document.querySelector("#hostUsername").value = config.host?.username || "";
  document.querySelector("#frontHost").value = config.frontHost || "127.0.0.1";
  document.querySelector("#frontPort").value = String(config.frontPort || 1573);
  document.querySelector("#seriesPaths").value = (config.seriesPaths || []).join("\n");
  document.querySelector("#monitorMemory").checked = Boolean(config.monitorMemory);
  document.querySelector("#memoryIntervalSeconds").value = String(config.memoryIntervalSeconds ?? 60);
  document.querySelector("#cacheBytes").value = String(config.cacheBytes ?? 0);
  document.querySelector("#cachePages").value = String(config.cachePages ?? 1);
  document.querySelector("#maxCacheablePageBytes").value = String(config.maxCacheablePageBytes ?? 0);
  document.querySelector("#idleAfterSeconds").value = String(config.idleAfterSeconds ?? 0);
  document.querySelector("#initialReconnectDelaySeconds").value = String(config.initialReconnectDelaySeconds ?? 1);
  document.querySelector("#maxReconnectDelaySeconds").value = String(config.maxReconnectDelaySeconds ?? 300);
}

function renderStatus(status) {
  const rows = [
    ["Frontend", status.frontendEnabled ? `enabled on http://${status.frontendHost}:${status.frontendPort}` : "disabled"],
    ["Backend link", status.connected ? "connected" : "disconnected"],
    ["Last connected", status.lastConnectedAt || "never"],
    ["Last disconnected", status.lastDisconnectedAt || "never"],
    ["Last error", status.lastError || "none"],
    ["Config file", status.configPath || "unknown"],
    ["WebSocket URL", status.wsUrl || "unknown"],
    ["Host", `${status.hostUsername || "unknown"} (${status.hostId || "unknown"})`],
    ["Library count", String((status.seriesPaths || []).length)],
  ];

  statusGrid.innerHTML = rows
    .map(([label, value]) => `<article class="status-card"><p class="status-label">${label}</p><p class="status-value">${value}</p></article>`)
    .join("");
}

function collectConfig() {
  return {
    wsUrl: document.querySelector("#wsUrl").value.trim(),
    seriesPaths: document
      .querySelector("#seriesPaths")
      .value
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
    host: {
      id: document.querySelector("#hostId").value.trim(),
      username: document.querySelector("#hostUsername").value.trim(),
    },
    frontHost: document.querySelector("#frontHost").value.trim(),
    frontPort: Number(document.querySelector("#frontPort").value),
    monitorMemory: document.querySelector("#monitorMemory").checked,
    memoryIntervalSeconds: Number(document.querySelector("#memoryIntervalSeconds").value),
    cacheBytes: Number(document.querySelector("#cacheBytes").value),
    cachePages: Number(document.querySelector("#cachePages").value),
    maxCacheablePageBytes: Number(document.querySelector("#maxCacheablePageBytes").value),
    idleAfterSeconds: Number(document.querySelector("#idleAfterSeconds").value),
    initialReconnectDelaySeconds: Number(document.querySelector("#initialReconnectDelaySeconds").value),
    maxReconnectDelaySeconds: Number(document.querySelector("#maxReconnectDelaySeconds").value),
  };
}

async function loadConfig() {
  setMessage("Loading config...");
  const config = await fetchJson("/api/config");
  populateForm(config);
  setMessage("Config loaded.", "ok");
}

async function loadStatus() {
  const status = await fetchJson("/api/status");
  renderStatus(status);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Saving config...");

  try {
    const payload = collectConfig();
    const result = await fetchJson("/api/config", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    setMessage(result.message, "ok");
    await loadStatus();
  } catch (error) {
    setMessage(String(error), "error");
  }
});

refreshStatusButton.addEventListener("click", async () => {
  try {
    await loadStatus();
    setMessage("Status refreshed.", "ok");
  } catch (error) {
    setMessage(String(error), "error");
  }
});

reloadConfigButton.addEventListener("click", async () => {
  try {
    await loadConfig();
    await loadStatus();
  } catch (error) {
    setMessage(String(error), "error");
  }
});

Promise.all([loadConfig(), loadStatus()]).catch((error) => {
  setMessage(String(error), "error");
});
