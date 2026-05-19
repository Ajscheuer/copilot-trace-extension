import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IExtensionDataService } from "azure-devops-extension-api";
import {
	IWorkItemFormService,
	WorkItemTrackingServiceIds,
} from "azure-devops-extension-api/WorkItemTracking";
import { queryAppInsights, AppInsightsConfig } from "./app-insights-client";
import { assembleTraces, renderTraces, renderEmpty, renderError, renderConfigWarning } from "./trace-renderer";

window.onerror = function(msg, src, line, col, err) {
	const el = document.getElementById("trace-container");
	if (el) {
		el.innerHTML = '<div style="color:red;padding:20px;font-family:monospace;white-space:pre-wrap;">Uncaught error: ' + msg + '\nSource: ' + src + '\nLine: ' + line + '\n' + (err?.stack || '') + '</div>';
	}
};

const container = document.getElementById("trace-container")!;

function executeEmbeddedScripts(root: HTMLElement) {
	const scripts = Array.from(root.querySelectorAll("script"));
	for (const script of scripts) {
		const code = script.textContent || "";
		if (!code.trim()) continue;
		try {
			new Function(code)();
		} catch (err) {
			console.error("Copilot Traces script execution error:", err);
		}
	}
}

async function getConfig(): Promise<AppInsightsConfig | null> {
	try {
		const dataService = await SDK.getService<IExtensionDataService>(
			CommonServiceIds.ExtensionDataService
		);
		const token = await SDK.getAccessToken();
		const dm = await dataService.getExtensionDataManager(SDK.getExtensionContext().id, token);

		let appId = await dm.getValue<any>("appInsightsAppId", { scopeType: "Default" });
		let clientId = await dm.getValue<any>("msalClientId", { scopeType: "Default" });
		let tenantId = await dm.getValue<any>("msalTenantId", { scopeType: "Default" });

		if (appId && typeof appId === "object" && appId.value) appId = appId.value;
		if (clientId && typeof clientId === "object" && clientId.value) clientId = clientId.value;
		if (tenantId && typeof tenantId === "object" && tenantId.value) tenantId = tenantId.value;

		if (!appId || !clientId || !tenantId) return null;
		return { appId: String(appId), clientId: String(clientId), tenantId: String(tenantId) };
	} catch (err) {
		console.error("Copilot Traces getConfig error:", err);
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
		const kql = `
			let workItemId = "${workItemId}";
			let matchingOps = dependencies
			| where cloud_RoleName == "copilot-chat"
			| where timestamp > ago(30d)
			| where customDimensions["ado.work_item_id"] == workItemId
				or (customDimensions["gen_ai.output.messages"] has "[TRACE_META]"
					and customDimensions["gen_ai.output.messages"] matches regex strcat("work_item: #", workItemId, "([^0-9]|$)"))
				or (customDimensions["gen_ai.input.messages"] has "[TRACE_META]"
					and customDimensions["gen_ai.input.messages"] matches regex strcat("work_item: #", workItemId, "([^0-9]|$)"))
				or (customDimensions["copilot_chat.user_request"] has "[TRACE_META]"
					and customDimensions["copilot_chat.user_request"] matches regex strcat("work_item: #", workItemId, "([^0-9]|$)"))
			| distinct operation_Id;
			dependencies
			| where operation_Id in (matchingOps)
			| where not(name has "copilot-nes" or name has "copilot-suggestions" or name has "himalia")
			| project timestamp, id, operation_Id, operation_ParentId,
				name, duration, success, resultCode, customDimensions,
				cloud_RoleName
			| order by timestamp asc
		`;

		const results = await queryAppInsights(config, kql);
		const traces = assembleTraces(results);

		if (traces.length === 0) {
			container.innerHTML = renderEmpty(workItemId);
		} else {
			container.innerHTML = renderTraces(workItemId, traces);
			executeEmbeddedScripts(container);
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

// -- Initialize ------------------------------------------------------
SDK.init().then(() => {
	SDK.register(SDK.getContributionId(), () => ({
		onLoaded: () => loadTraces().then(() => addRefreshHandler()),
		onRefreshed: () => loadTraces().then(() => addRefreshHandler()),
	}));

	SDK.ready().then(() => {
		loadTraces().then(() => addRefreshHandler());
	});
}).catch((err) => {
	const el = document.getElementById("trace-container");
	if (el) {
		el.innerHTML = '<div style="color:red;padding:20px;font-family:monospace;white-space:pre-wrap;">SDK init error: ' + (err?.message || JSON.stringify(err)) + '</div>';
	}
});
