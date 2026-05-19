import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IExtensionDataService } from "azure-devops-extension-api";

const appIdInput = document.getElementById("appId") as HTMLInputElement;
const clientIdInput = document.getElementById("clientId") as HTMLInputElement;
const tenantIdInput = document.getElementById("tenantId") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function showStatus(message: string, type: "success" | "error") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

async function getDataManager() {
  const dataService = await SDK.getService<IExtensionDataService>(CommonServiceIds.ExtensionDataService);
  const token = await SDK.getAccessToken();
  return dataService.getExtensionDataManager(SDK.getExtensionContext().id, token);
}

async function loadSettings() {
  try {
    const dm = await getDataManager();
    const appId = await dm.getValue<string>("appInsightsAppId", { scopeType: "Default" });
    const clientId = await dm.getValue<string>("msalClientId", { scopeType: "Default" });
    const tenantId = await dm.getValue<string>("msalTenantId", { scopeType: "Default" });

    if (appId) appIdInput.value = appId;
    if (clientId) clientIdInput.value = clientId;
    if (tenantId) tenantIdInput.value = tenantId;
  } catch {
    // First time - no settings saved yet
  }
}

async function saveSettings() {
  const appId = appIdInput.value.trim();
  const clientId = clientIdInput.value.trim();
  const tenantId = tenantIdInput.value.trim();

  if (!appId || !clientId || !tenantId) {
    showStatus("Application ID, Azure AD Client ID, and Azure AD Tenant ID are required.", "error");
    return;
  }

  try {
    const dm = await getDataManager();
    await dm.setValue("appInsightsAppId", appId, { scopeType: "Default" });
    await dm.setValue("msalClientId", clientId, { scopeType: "Default" });
    await dm.setValue("msalTenantId", tenantId, { scopeType: "Default" });

    showStatus("Settings saved. No secrets are stored; authentication occurs via Azure AD at query time.", "success");
  } catch (err: any) {
    showStatus(`Error: ${err.message || err}`, "error");
  }
}

saveBtn.addEventListener("click", saveSettings);

SDK.init().then(() => {
  SDK.ready().then(() => loadSettings());
});
