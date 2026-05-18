# Copilot Agent Traces — Azure DevOps Extension

Adds an **Agent Traces** tab to every Azure DevOps work item that shows GitHub Copilot agent session traces in real time, powered by Application Insights and OpenTelemetry.

## What It Shows

When you click the "Agent Traces" tab on any work item, you see:

- **Session metadata** — timestamp, duration, token count, model
- **Agent execution flow** — which agents ran, SDLC phase badges, tools used, duration per agent
- **Failure/retry loops** — what failed, how it was classified, where it was routed
- **Validation gates** — pass/fail per gate with timing
- **Files changed** — paths and line counts

Data is queried live from Application Insights — no stored artifacts, no stale data.

## Prerequisites

1. **Application Insights** — already receiving Copilot OTel traces
2. **VS Code Copilot OTel** — enabled with `github.copilot.chat.otel.enabled: true`
3. **OTel Collector** — forwarding traces from VS Code to App Insights
4. **Work item tagging** — traces tagged with work item ID via `OTEL_RESOURCE_ATTRIBUTES` or branch naming

## Quick Start

### 1. Build

```bash
npm install
npm run build
```

### 2. Package

```bash
npx tfx-cli extension create --manifest-globs vss-extension.json
```

This produces a `.vsix` file.

### 3. Install (private, your org only)

1. Go to `https://dev.azure.com/{yourOrg}/_settings/extensions`
2. Click **Browse local extensions** → **Manage extensions**
3. Click **Upload extension** → select the `.vsix` file
4. Click **Install** → select your project
5. The "Agent Traces" tab appears on all work items immediately

### 4. Configure

1. Go to **Project Settings** → **Agent Traces Settings**
2. Enter your App Insights **Application ID** and **API Key**
   - Azure Portal → Application Insights → API Access
   - Copy the Application ID
   - Click "Create API Key" → select "Read telemetry"
3. Click **Save Settings**

### 5. Tag Traces with Work Item IDs

Traces need to include the work item ID so the extension can filter by it. Two approaches:

**Option A: Branch naming convention (recommended)**

Name your branches with the work item number:
```
feature/1234-add-customer-search
bugfix/5678-fix-pagination
```

Then set a resource attribute that extracts it:
```bash
# Add to your shell profile or a project hook
BRANCH=$(git branch --show-current)
WI_ID=$(echo $BRANCH | grep -oP '\d{3,}' | head -1)
export OTEL_RESOURCE_ATTRIBUTES="ado.work_item_id=$WI_ID"
```

**Option B: Manual per session**
```bash
export OTEL_RESOURCE_ATTRIBUTES="ado.work_item_id=1234"
```

## Development

```bash
npm install
npm run dev     # webpack watch mode
```

To test locally, use `tfx extension publish --share-with yourOrg` with a dev publisher.

## Project Structure

```
vss-extension.json           Extension manifest
src/
  trace-tab.html             Tab page HTML template
  trace-tab.ts               Main logic: SDK init, query, render
  app-insights-client.ts     App Insights REST API client
  trace-renderer.ts          Span assembly + HTML visualization
  settings.html              Settings page HTML
  settings.ts                Settings page logic
static/
  icon.png                   Extension icon
```

## Publisher Setup (first time only)

Before you can upload the extension, you need a publisher ID:

1. Go to https://marketplace.visualstudio.com/manage
2. Click **Create publisher**
3. Pick an ID (e.g., `your-company-name`)
4. Update `"publisher"` in `vss-extension.json` with your publisher ID

## How the Query Works

The extension runs this KQL against App Insights:

```kusto
dependencies
| where cloud_RoleName == "copilot-chat"
| where timestamp > ago(30d)
| where customDimensions has "{workItemId}"
    or customDimensions["ado.work_item_id"] == "{workItemId}"
| project timestamp, id, operation_Id, operation_ParentId,
    name, duration, success, resultCode, customDimensions
| order by timestamp desc
```

It groups spans by `operation_Id` (one per agent session), builds the span tree, and renders the visualization.

## Updating

Build a new `.vsix` and upload it again — the update propagates to all users immediately.

## License

MIT
