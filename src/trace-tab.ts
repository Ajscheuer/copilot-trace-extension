import * as SDK from "azure-devops-extension-sdk";
import {
  IWorkItemFormService,
  WorkItemTrackingServiceIds,
} from "azure-devops-extension-api/WorkItemTracking";
import { queryAppInsights, AppInsightsConfig } from "./app-insights-client";
import { assembleTraces, renderTraces, renderEmpty, renderError, renderConfigWarning } from "./trace-renderer";

const container = document.getElementById("trace-container")!;

async function getConfig(): Promise<AppInsightsConfig | null> {
  try {
    const dataService = await SDK.getService<any>(
      "ms.vso.web.data-service" as any
    );
    // Extension data is scoped to the project
    const appId = await dataService.getValue("appInsightsAppId", { scopeType: "Default" });
    const apiKey = await dataService.getValue("appInsightsApiKey", { scopeType: "Default" });

    if (!appId || !apiKey) return null;
    return { appId, apiKey };
  } catch {
    // Fallback: check if config is in localStorage (for dev/testing)
    const appId = localStorage.getItem("copilotTraces.appId");
    const apiKey = localStorage.getItem("copilotTraces.apiKey");
    if (appId && apiKey) return { appId, apiKey };
    return null;
  }
}

async function getWorkItemId(): Promise<number | null> {
  try {
    const formService = await SDK.getService<IWorkItemFormService>(
      WorkItemTrackingServiceIds.WorkItemFormService
    );
    return await formService.getId();
  } catch {
    return null;
  }
}

async function loadTraces() {
  container.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>Loading agent traces...</div>
    </div>`;

  const config = await getConfig();
  if (!config) {
    container.innerHTML = renderConfigWarning();
    return;
  }

  const workItemId = await getWorkItemId();
  if (!workItemId) {
    container.innerHTML = renderError("Could not determine the current work item ID.");
    return;
  }

  try {
    // Query App Insights for traces tagged with this work item ID
    // The KQL query looks for spans where the work item ID appears in:
    // 1. OTEL_RESOURCE_ATTRIBUTES (ado.work_item_id)
    // 2. customDimensions (from branch name parsing)
    // 3. The span content itself (prompt text mentioning the work item)
    const kql = `
      let workItemId = "${workItemId}";
      let traces_data = dependencies
        | where cloud_RoleName == "copilot-chat"
        | where timestamp > ago(30d)
        | where customDimensions has workItemId
            or customDimensions["ado.work_item_id"] == workItemId
        | project
            timestamp,
            id,
            operation_Id,
            operation_ParentId,
            name,
            duration,
            success,
            resultCode,
            customDimensions,
            cloud_RoleName
        | order by timestamp desc;
      traces_data
    `;

    const results = await queryAppInsights(config, kql);
    const traces = assembleTraces(results);

    if (traces.length === 0) {
      container.innerHTML = renderEmpty(workItemId);
    } else {
      container.innerHTML = renderTraces(workItemId, traces);
    }
  } catch (err: any) {
    container.innerHTML = renderError(
      `Failed to query Application Insights: ${err.message || err}`
    );
  }
}

function addRefreshHandler() {
  const btn = container.querySelector(".refresh-btn");
  if (btn) {
    btn.addEventListener("click", () => loadTraces());
  }
}

// ── Initialize ──────────────────────────────────────────────────────
SDK.init().then(() => {
  SDK.ready().then(() => {
    loadTraces().then(() => addRefreshHandler());
  });
});

// Re-load when the work item changes (navigation within a query result list)
SDK.register(SDK.getContributionId(), () => ({
  onLoaded: () => loadTraces().then(() => addRefreshHandler()),
  onRefreshed: () => loadTraces().then(() => addRefreshHandler()),
}));
