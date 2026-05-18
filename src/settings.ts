import * as SDK from "azure-devops-extension-sdk";

const appIdInput = document.getElementById("appId") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function showStatus(message: string, type: "success" | "error") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

async function loadSettings() {
  try {
    const dataService = await SDK.getService<any>("ms.vso.web.data-service" as any);
    const appId = await dataService.getValue("appInsightsAppId", { scopeType: "Default" });
    const apiKey = await dataService.getValue("appInsightsApiKey", { scopeType: "Default" });

    if (appId) appIdInput.value = appId;
    if (apiKey) apiKeyInput.value = apiKey;
  } catch {
    // First time — no settings saved yet
  }
}

async function saveSettings() {
  const appId = appIdInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!appId || !apiKey) {
    showStatus("Both Application ID and API Key are required.", "error");
    return;
  }

  try {
    // Validate by making a test query
    const testUrl = `https://api.applicationinsights.io/v1/apps/${appId}/query`;
    const testResponse = await fetch(testUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ query: "dependencies | take 1" }),
    });

    if (!testResponse.ok) {
      showStatus(`Connection test failed (HTTP ${testResponse.status}). Check your credentials.`, "error");
      return;
    }

    // Save to extension data service
    const dataService = await SDK.getService<any>("ms.vso.web.data-service" as any);
    await dataService.setValue("appInsightsAppId", appId, { scopeType: "Default" });
    await dataService.setValue("appInsightsApiKey", apiKey, { scopeType: "Default" });

    showStatus("Settings saved and connection verified.", "success");
  } catch (err: any) {
    showStatus(`Error: ${err.message || err}`, "error");
  }
}

saveBtn.addEventListener("click", saveSettings);

SDK.init().then(() => {
  SDK.ready().then(() => loadSettings());
});
