// ── Types ────────────────────────────────────────────────────────────

export interface AgentSpan {
  timestamp: string;
  id: string;
  operationId: string;
  parentId: string;
  name: string;
  duration: number;
  success: boolean;
  customDimensions: Record<string, any>;
}

export interface AgentSession {
  operationId: string;
  timestamp: string;
  totalDuration: number;
  totalTokens: number;
  model: string;
  agents: AgentExecution[];
  tools: string[];
  success: boolean;
}

export interface AgentExecution {
  name: string;
  phase: string;
  duration: number;
  tokens: number;
  tools: string[];
  success: boolean;
}

// ── Phase detection ──────────────────────────────────────────────────

const PHASE_MAP: Record<string, string> = {
  planner: "PLAN",
  "sdlc planner": "PLAN",
  "contract owner": "DESIGN",
  "contract": "DESIGN",
  "api agent": "BUILD",
  "api": "BUILD",
  "data agent": "BUILD",
  "data": "BUILD",
  "frontend agent": "BUILD",
  "frontend": "BUILD",
  "testing agent": "TEST",
  "testing": "TEST",
  "security": "REVIEW",
};

const PHASE_COLORS: Record<string, string> = {
  PLAN: "#0078d4",
  DESIGN: "#038387",
  BUILD: "#8764b8",
  TEST: "#ca5010",
  REVIEW: "#107c10",
};

function detectPhase(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, phase] of Object.entries(PHASE_MAP)) {
    if (lower.includes(key)) return phase;
  }
  return "BUILD";
}

function phaseColor(phase: string): string {
  return PHASE_COLORS[phase] || "#605e5c";
}

function ms(duration: number): string {
  if (duration < 1000) return `${Math.round(duration)}ms`;
  const s = duration / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function tokenFmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── Assemble raw spans into sessions ─────────────────────────────────

export function assembleTraces(rows: any[]): AgentSession[] {
  // Group by operation_Id (each operation is one agent session)
  const groups: Record<string, any[]> = {};
  for (const row of rows) {
    const opId = row.operation_Id || row.operationId || "unknown";
    if (!groups[opId]) groups[opId] = [];
    groups[opId].push(row);
  }

  return Object.entries(groups).map(([opId, spans]) => {
    // Sort by timestamp
    spans.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const firstSpan = spans[0];
    const dims = firstSpan.customDimensions || {};

    // Extract agent invocations
    const agentSpans = spans.filter((s: any) =>
      s.name?.includes("invoke_agent") || s.name?.includes("chat") || s.name?.includes("execute_tool")
    );

    // Group agent executions
    const agents: AgentExecution[] = [];
    const toolSet = new Set<string>();
    let totalTokens = 0;

    for (const span of spans) {
      const d = span.customDimensions || {};
      const inputTokens = parseInt(d["gen_ai.usage.input_tokens"] || "0");
      const outputTokens = parseInt(d["gen_ai.usage.output_tokens"] || "0");
      totalTokens += inputTokens + outputTokens;

      if (d["gen_ai.tool.name"]) {
        toolSet.add(d["gen_ai.tool.name"]);
      }

      // Detect agent invocations
      if (span.name?.includes("invoke_agent")) {
        const agentName = span.name.replace("invoke_agent ", "").trim();
        const phase = detectPhase(agentName);
        const agentTools = spans
          .filter((s: any) => s.operation_ParentId === span.id && s.name?.includes("execute_tool"))
          .map((s: any) => (s.customDimensions || {})["gen_ai.tool.name"] || s.name.replace("execute_tool ", ""))
          .filter(Boolean);

        agents.push({
          name: agentName || "Unknown Agent",
          phase,
          duration: span.duration || 0,
          tokens: inputTokens + outputTokens,
          tools: [...new Set(agentTools)],
          success: span.success !== false,
        });
      }
    }

    // Calculate total duration from first to last span
    const totalDuration = spans.reduce((max: number, s: any) => Math.max(max, s.duration || 0), 0);

    return {
      operationId: opId,
      timestamp: firstSpan.timestamp,
      totalDuration,
      totalTokens,
      model: dims["gen_ai.request.model"] || "Unknown",
      agents: agents.length > 0 ? agents : [{
        name: spans[0]?.name || "Agent Session",
        phase: "BUILD",
        duration: totalDuration,
        tokens: totalTokens,
        tools: [...toolSet],
        success: true,
      }],
      tools: [...toolSet],
      success: spans.every((s: any) => s.success !== false),
    };
  }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ── Render functions ─────────────────────────────────────────────────

export function renderTraces(workItemId: number, sessions: AgentSession[]): string {
  return `
    <div class="info-bar">
      <h3>Agent Activity for WI ${workItemId}</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="conn"><span class="dot"></span> Connected to Application Insights</div>
        <button class="refresh-btn">↻ Refresh</button>
      </div>
    </div>
    ${sessions.map((s) => renderSession(s)).join("")}
    <div style="font-size:11px;color:#a19f9d;font-style:italic;margin-top:8px;">
      ${sessions.length} session${sessions.length !== 1 ? "s" : ""} found
    </div>
  `;
}

function renderSession(session: AgentSession): string {
  const statusBg = session.success ? "#dff6dd" : "#fef2f2";
  const statusColor = session.success ? "#107c10" : "#a4262c";
  const statusText = session.success ? "✓ Completed" : "✗ Errors";
  const date = new Date(session.timestamp).toLocaleString();

  return `
    <div style="border:1px solid #edebe9;border-radius:2px;margin-bottom:12px;">
      <div style="padding:10px 14px;background:#faf9f8;border-bottom:1px solid #edebe9;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-weight:600;font-size:13px;">Agent Session</span>
          <span style="font-size:12px;color:#a19f9d;margin-left:10px;">${date}</span>
        </div>
        <span style="background:${statusBg};color:${statusColor};font-size:11px;padding:2px 8px;border-radius:2px;font-weight:600;">${statusText}</span>
      </div>

      <div style="display:flex;gap:24px;padding:10px 14px;border-bottom:1px solid #f3f2f1;">
        ${metricHtml("Duration", ms(session.totalDuration), "#0078d4")}
        ${metricHtml("Tokens", tokenFmt(session.totalTokens), "#8764b8")}
        ${metricHtml("Agents", String(session.agents.length), "#323130")}
        ${metricHtml("Model", session.model, "#605e5c")}
      </div>

      <div style="padding:10px 14px;">
        <div style="font-size:12px;font-weight:600;color:#605e5c;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">Agent Execution</div>
        ${session.agents.map((a) => renderAgent(a)).join("")}
      </div>
    </div>
  `;
}

function metricHtml(label: string, value: string, color: string): string {
  return `
    <div>
      <div style="font-size:11px;color:#a19f9d;text-transform:uppercase;letter-spacing:0.3px;">${label}</div>
      <div style="font-size:16px;font-weight:700;color:${color};">${value}</div>
    </div>
  `;
}

function renderAgent(agent: AgentExecution): string {
  const color = phaseColor(agent.phase);
  const initial = agent.name.charAt(0).toUpperCase();

  return `
    <div style="display:flex;align-items:flex-start;padding:7px 0;border-bottom:1px solid #f3f2f1;">
      <div style="width:26px;height:26px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:10px;margin-top:1px;">${initial}</div>
      <div style="flex:1;min-width:0;">
        <span style="font-size:13px;font-weight:600;color:#323130;">${agent.name}</span>
        <span style="display:inline-block;font-size:10px;padding:1px 5px;border-radius:2px;color:#fff;background:${color};font-weight:600;margin-left:5px;vertical-align:middle;">${agent.phase}</span>
        ${agent.tools.length > 0 ? `
          <div style="font-size:11px;color:#a19f9d;margin-top:2px;">
            ${agent.tools.map((t) => `<code style="background:#f3f2f1;padding:0 4px;border-radius:2px;font-family:'Cascadia Code',Consolas,monospace;font-size:10px;">${t}</code>`).join(" ")}
          </div>
        ` : ""}
      </div>
      <div style="font-size:11px;color:#a19f9d;text-align:right;white-space:nowrap;min-width:100px;margin-top:2px;">
        ${ms(agent.duration)} · ${tokenFmt(agent.tokens)}
      </div>
    </div>
  `;
}

export function renderEmpty(workItemId: number): string {
  return `
    <div class="info-bar">
      <h3>Agent Activity for WI ${workItemId}</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="conn"><span class="dot"></span> Connected to Application Insights</div>
        <button class="refresh-btn">↻ Refresh</button>
      </div>
    </div>
    <div class="empty">
      <div class="icon">🔍</div>
      <div style="font-size:14px;font-weight:600;color:#323130;margin-bottom:4px;">No agent traces found</div>
      <div>No Copilot agent sessions have been tagged with work item ${workItemId}.</div>
      <div style="margin-top:12px;font-size:12px;color:#605e5c;">
        Ensure your Git branch includes the work item number (e.g., <code>feature/${workItemId}-description</code>)
        and that <code>OTEL_RESOURCE_ATTRIBUTES</code> includes <code>ado.work_item_id=${workItemId}</code>.
      </div>
    </div>
  `;
}

export function renderError(message: string): string {
  return `<div class="error"><strong>Error:</strong> ${message}</div>`;
}

export function renderConfigWarning(): string {
  return `
    <div class="config-warning">
      <strong>Configuration Required</strong>
      <p style="margin-top:8px;">
        The Copilot Agent Traces extension needs an Application Insights connection.
        Go to <strong>Project Settings → Agent Traces Settings</strong> and enter your
        App Insights Application ID and API Key.
      </p>
      <p style="margin-top:8px;font-size:12px;">
        To get these values: Azure Portal → Application Insights → API Access →
        copy the Application ID and create an API Key with "Read telemetry" permission.
      </p>
    </div>
  `;
}
