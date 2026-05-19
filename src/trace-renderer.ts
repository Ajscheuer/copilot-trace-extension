// ── Types ────────────────────────────────────────────────────────────

export interface AgentExecution {
  id: string;
  parentId: string;
  name: string;
  phase: string;
  duration: number;
  tokens: number;
  tools: string[];
  success: boolean;
  retries: number;
  description: string;
  filesChanged: number;
  model: string;
  children: string[];
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
  retryCount: number;
  validationGates: ValidationGate[];
}

export interface ValidationGate {
  name: string;
  passed: boolean;
  duration: number;
  detail: string;
}

// ── Constants ────────────────────────────────────────────────────────

const PHASE_MAP: Record<string, string> = {
  planner: "PLAN", "sdlc planner": "PLAN", plan: "PLAN",
  "contract owner": "DESIGN", contract: "DESIGN", design: "DESIGN",
  "api agent": "BUILD", api: "BUILD",
  "data agent": "BUILD", data: "BUILD",
  "frontend agent": "BUILD", frontend: "BUILD",
  "ui agent": "BUILD", ui: "BUILD",
  build: "BUILD", coder: "BUILD", implement: "BUILD",
  "testing agent": "TEST", testing: "TEST", test: "TEST",
  security: "REVIEW", review: "REVIEW",
};

const PHASE_COLORS: Record<string, string> = {
  PLAN: "#0078d4", DESIGN: "#038387", BUILD: "#8764b8",
  TEST: "#ca5010", REVIEW: "#107c10", VALIDATE: "#107c10",
};

const VALIDATION_COMMANDS = ["lint", "typecheck", "test", "build", "check"];

// ── Helpers ──────────────────────────────────────────────────────────

function detectPhase(name: string, span?: any): string {
  // 1. Check [TRACE_META] block for explicit phase
  if (span) {
    const meta = parseTraceMeta(span);
    if (meta.phase) {
      const upper = meta.phase.toUpperCase();
      if (PHASE_COLORS[upper]) return upper;
    }
    // Check if this is the root panel agent (planner)
    const agentAttr = (span.customDimensions || {})["gen_ai.agent.name"] || "";
    if (agentAttr === "panel/editAgent") return "PLAN";
  }

  // 2. Infer from agent name
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
  if (n === 0) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function estimateCost(tokens: number, model: string): string {
  const lower = model.toLowerCase();
  let costPer1k = 0.003;
  if (lower.includes("gpt-4o-mini")) costPer1k = 0.00015;
  else if (lower.includes("gpt-4o")) costPer1k = 0.005;
  else if (lower.includes("gpt-4")) costPer1k = 0.03;
  else if (lower.includes("claude") && lower.includes("sonnet")) costPer1k = 0.003;
  else if (lower.includes("claude") && lower.includes("opus")) costPer1k = 0.015;
  else if (lower.includes("claude") && lower.includes("haiku")) costPer1k = 0.00025;
  const cost = (tokens / 1000) * costPer1k;
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

function parseTraceMeta(span: any): Record<string, string> {
  const dims = span.customDimensions || {};
  const output = dims["gen_ai.output.messages"] || dims["gen_ai.input.messages"] || "";
  const match = output.match(/\[TRACE_META\]([\s\S]*?)\[\/TRACE_META\]/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  const lines = match[1].split(/\\n|\n/);
  for (const line of lines) {
    const kv = line.match(/^\s*(\w[\w_]*)\s*:\s*(.+)\s*$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return meta;
}

function parseAgentName(span: any): string {
  const dims = span.customDimensions || {};

  // 1. Best: structured attribute from Copilot (copilot_chat.mode_name is the cleanest)
  const modeName = dims["copilot_chat.mode_name"];
  if (modeName && modeName !== "editAgent") return modeName;

  // 2. gen_ai.agent.name — strip prefixes like "tool/runSubagent-" and "panel/"
  const agentAttr = dims["gen_ai.agent.name"] || "";
  if (agentAttr) {
    const cleaned = agentAttr
      .replace(/^tool\/runSubagent-/i, "")
      .replace(/^panel\//i, "")
      .trim();
    if (cleaned && cleaned !== "editAgent" && cleaned !== "copilot" && cleaned !== "claude") {
      return cleaned;
    }
  }

  // 3. copilot_chat.debug_log_label — e.g. "runSubagent-Contract Owner"
  const debugLabel = dims["copilot_chat.debug_log_label"] || "";
  if (debugLabel) {
    const cleaned = debugLabel.replace(/^runSubagent-/i, "").trim();
    if (cleaned) return cleaned;
  }

  // 4. [TRACE_META] block in output
  const meta = parseTraceMeta(span);
  if (meta.agent) return meta.agent;

  // 5. Span name — e.g. "invoke_agent Contract Owner"
  const rawName = (span.name || "").replace("invoke_agent ", "").trim();
  if (rawName && rawName !== "copilot" && rawName !== "claude") {
    return rawName.charAt(0).toUpperCase() + rawName.slice(1);
  }

  // 6. Parse from prompt content
  const inputMsgs = dims["gen_ai.input.messages"] || "";
  const nameMatch = inputMsgs.match(/You are the ([A-Z][A-Za-z\s]+?)(?:\.|agent|Agent)/);
  if (nameMatch) return nameMatch[1].trim();

  return rawName || "Agent";
}

function extractDescription(spans: any[], agentSpanId: string): string {
  // First try the invoke_agent span's own output (has the final summary)
  const agentSpan = spans.find((s: any) => s.id === agentSpanId);
  let output = "";
  if (agentSpan) {
    output = (agentSpan.customDimensions || {})["gen_ai.output.messages"] || "";
  }
  // Fallback: last chat child span
  if (!output) {
    const chatSpans = spans.filter(
      (s: any) => s.operation_ParentId === agentSpanId && s.name?.includes("chat")
    );
    if (chatSpans.length === 0) return "";
    const lastChat = chatSpans[chatSpans.length - 1];
    output = (lastChat.customDimensions || {})["gen_ai.output.messages"] || "";
  }
  if (!output) return "";
  // Strip [TRACE_META] block
  let cleaned = output.replace(/\[TRACE_META\][\s\S]*?\[\/TRACE_META\]\s*/g, "");
  // Strip JSON wrapper if present (messages are often JSON arrays)
  const contentMatch = cleaned.match(/"content"\s*:\s*"([\s\S]*?)(?:"\s*[}\]])/);
  if (contentMatch) cleaned = contentMatch[1];
  // Clean up escaped chars and code blocks
  cleaned = cleaned
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/~~~[\s\S]*?~~~/g, "[code]")
    .replace(/\n{2,}/g, "\n")
    .substring(0, 800);
  return cleaned.trim();
}

function countFilesChanged(spans: any[], agentSpanId: string): number {
  const editSpans = spans.filter(
    (s: any) =>
      s.operation_ParentId === agentSpanId &&
      s.name?.includes("execute_tool") &&
      ((s.customDimensions || {})["gen_ai.tool.name"] || "").match(/edit|create|write/i)
  );
  return editSpans.length;
}

// ── Assemble ─────────────────────────────────────────────────────────

export function assembleTraces(inputRows: any[]): AgentSession[] {
  let rows = inputRows.filter((row: any) => {
    const name = row.name || "";
    const dims = row.customDimensions || {};
    const model = dims["gen_ai.request.model"] || dims["gen_ai.response.model"] || name;
    const agentName = dims["gen_ai.agent.name"] || "";

    // Filter out background Copilot features (not agent sessions)
    if (model.includes("copilot-nes") || model.includes("copilot-suggestions") || model.includes("himalia")) return false;
    if (name.includes("copilot-nes") || name.includes("copilot-suggestions") || name.includes("himalia")) return false;

    // Filter out gpt-4o-mini spans that are background intent detection, not user-initiated agent work
    // These are sub-second spans with no tools and no agent name — they're Copilot internal classifiers
    if ((model.includes("gpt-4o-mini") || name.includes("gpt-4o-mini")) && !agentName && (row.duration || 0) < 2000) return false;

    return true;
  });

  const groups: Record<string, any[]> = {};
  for (const row of rows) {
    const opId = row.operation_Id || row.operationId || "unknown";
    if (!groups[opId]) groups[opId] = [];
    groups[opId].push(row);
  }

  return Object.entries(groups)
    .map(([opId, spans]) => {
      spans.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const firstSpan = spans[0];
      const dims = firstSpan.customDimensions || {};
      const toolSet = new Set<string>();
      let totalTokens = 0;

      for (const span of spans) {
        const d = span.customDimensions || {};
        totalTokens += parseInt(d["gen_ai.usage.input_tokens"] || "0") + parseInt(d["gen_ai.usage.output_tokens"] || "0");
        if (d["gen_ai.tool.name"]) toolSet.add(d["gen_ai.tool.name"]);
      }

      const invokeSpans = spans.filter((s: any) => s.name?.includes("invoke_agent"));
      const agentNameCount: Record<string, number> = {};
      const agents: AgentExecution[] = [];

      // Detect root planner: chat spans with gen_ai.agent.name == "panel/editAgent"
      // that are NOT children of an invoke_agent span
      const invokeIds = new Set(invokeSpans.map((s: any) => s.id));
      const plannerSpans = spans.filter((s: any) => {
        const d = s.customDimensions || {};
        const agentName = d["gen_ai.agent.name"] || "";
        return (agentName === "panel/editAgent" || agentName.startsWith("panel/"))
          && !invokeIds.has(s.id)
          && s.name?.includes("chat");
      });

      // Synthesize a planner agent if planner spans exist and there are subagents
      if (plannerSpans.length > 0 && invokeSpans.length > 0) {
        const plannerTokens = plannerSpans.reduce((sum: number, s: any) => {
          const d = s.customDimensions || {};
          return sum + parseInt(d["gen_ai.usage.input_tokens"] || "0") + parseInt(d["gen_ai.usage.output_tokens"] || "0");
        }, 0);
        const plannerDuration = plannerSpans.reduce((sum: number, s: any) => sum + (s.duration || 0), 0);
        const plannerParent = plannerSpans[0].operation_ParentId || "";
        const plannerModel = (plannerSpans[0].customDimensions || {})["gen_ai.request.model"] || "Unknown";
        const plannerId = plannerParent || "planner-root";

        agents.push({
          id: plannerId,
          parentId: "",
          name: "SDLC Planner",
          phase: "PLAN",
          duration: plannerDuration,
          tokens: plannerTokens,
          tools: [],
          success: plannerSpans.every((s: any) => s.success !== false),
          retries: 0,
          description: extractDescription(spans, plannerSpans[plannerSpans.length - 1].id),
          filesChanged: 0,
          model: plannerModel,
          children: invokeSpans.map((s: any) => s.id),
        });
      }

      for (const span of invokeSpans) {
        const name = parseAgentName(span);
        agentNameCount[name] = (agentNameCount[name] || 0) + 1;
        const d = span.customDimensions || {};
        const spanTokens = parseInt(d["gen_ai.usage.input_tokens"] || "0") + parseInt(d["gen_ai.usage.output_tokens"] || "0");

        const agentTools = spans
          .filter((s: any) => s.operation_ParentId === span.id && s.name?.includes("execute_tool"))
          .map((s: any) => (s.customDimensions || {})["gen_ai.tool.name"] || s.name.replace("execute_tool ", ""))
          .filter(Boolean);

        // Set parentId: if we synthesized a planner, subagents point to it
        const parentId = (agents.length > 0 && agents[0].name === "SDLC Planner")
          ? agents[0].id
          : (span.operation_ParentId || "");

        agents.push({
          id: span.id,
          parentId,
          name,
          phase: detectPhase(name, span),
          duration: span.duration || 0,
          tokens: spanTokens,
          tools: [...new Set(agentTools)],
          success: span.success !== false,
          retries: 0,
          description: extractDescription(spans, span.id),
          filesChanged: countFilesChanged(spans, span.id),
          model: d["gen_ai.request.model"] || dims["gen_ai.request.model"] || "Unknown",
          children: invokeSpans.filter((c: any) => c.operation_ParentId === span.id).map((c: any) => c.id),
        });
      }

      for (const name of Object.keys(agentNameCount)) {
        if (agentNameCount[name] > 1) {
          const matching = agents.filter((a) => a.name === name);
          matching.forEach((a, i) => {
            if (i > 0) a.retries = i;
          });
        }
      }

      const validationGates: ValidationGate[] = spans
        .filter((s: any) => {
          const toolName = ((s.customDimensions || {})["gen_ai.tool.name"] || s.name || "").toLowerCase();
          return s.name?.includes("execute_tool") && VALIDATION_COMMANDS.some((c) => toolName.includes(c));
        })
        .map((s: any) => ({
          name: (s.customDimensions || {})["gen_ai.tool.name"] || s.name.replace("execute_tool ", ""),
          passed: s.success !== false,
          duration: s.duration || 0,
          detail: ((s.customDimensions || {})["gen_ai.tool.call.arguments"] || "").substring(0, 200),
        }));

      const totalDuration = spans.reduce((max: number, s: any) => Math.max(max, s.duration || 0), 0);
      const retryCount = agents.filter((a) => a.retries > 0).length;

      if (agents.length === 0) {
        agents.push({
          id: firstSpan.id || "root",
          parentId: "",
          name: firstSpan.name || "Agent session",
          phase: "BUILD",
          duration: totalDuration,
          tokens: totalTokens,
          tools: [...toolSet],
          success: true,
          retries: 0,
          description: "",
          filesChanged: 0,
          model: dims["gen_ai.request.model"] || "Unknown",
          children: [],
        });
      }

      return {
        operationId: opId,
        timestamp: firstSpan.timestamp,
        totalDuration,
        totalTokens,
        model: dims["gen_ai.request.model"] || agents[0]?.model || "Unknown",
        agents,
        tools: [...toolSet],
        success: spans.every((s: any) => s.success !== false),
        retryCount,
        validationGates,
      };
    })
    .filter((session) => {
      // Keep sessions that have real agent work
      if (session.agents.some((a) => a.name !== "GitHub Copilot Chat" && a.name !== "Agent")) return true;
      // Keep sessions that used subagents (invoke_agent spans)
      if (session.agents.length > 1) return true;
      // Keep sessions with meaningful tools (not just classifiers)
      if (session.tools.length > 0) return true;
      // Keep sessions over 5 seconds (real agent work takes time)
      if (session.totalDuration > 5000) return true;
      // Everything else is background noise
      return false;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ── Flow graph renderer ──────────────────────────────────────────────

function buildTiers(agents: AgentExecution[]): AgentExecution[][] {
  if (agents.length <= 1) return [agents];

  const idSet = new Set(agents.map((a) => a.id));
  const root = agents.find((a) => !idSet.has(a.parentId)) || agents[0];
  const children = agents.filter((a) => a.id !== root.id && a.parentId === root.id);
  const grandchildren = agents.filter((a) => a.id !== root.id && !children.includes(a) && children.some((c) => c.id === a.parentId));
  const rest = agents.filter((a) => a !== root && !children.includes(a) && !grandchildren.includes(a));

  const buildAgents = [...children, ...rest].filter((a) => a.phase === "BUILD" || a.phase === "DESIGN");
  const testAgents = [...children, ...grandchildren, ...rest].filter((a) => a.phase === "TEST" || a.phase === "REVIEW");
  const otherAgents = [...children, ...rest].filter((a) => !buildAgents.includes(a) && !testAgents.includes(a));

  const tiers: AgentExecution[][] = [[root]];

  const tier1 = [...buildAgents, ...otherAgents].filter((a) => !testAgents.includes(a));
  if (tier1.length > 0) tiers.push(tier1);

  if (testAgents.length > 0) tiers.push(testAgents);

  return tiers;
}

function renderFlowSession(session: AgentSession, sessionIdx: number): string {
  const isSimple = session.agents.length <= 1;

  if (isSimple) {
    return renderSimpleSession(session, sessionIdx);
  }

  const tiers = buildTiers(session.agents);
  const date = new Date(session.timestamp).toLocaleString();
  const statusBg = session.success ? "#dff6dd" : "#fef2f2";
  const statusColor = session.success ? "#107c10" : "#a4262c";
  const statusText = session.success ? "✓ All gates passed" : "✗ Errors detected";

  const NODE_W = 130;
  const NODE_H = 110;
  const TIER_GAP = 60;
  const CANVAS_W = 660;
  const tierStartY = 10;

  let nodesHtml = "";
  let linesHtml = "";
  const nodePositions: Record<string, { cx: number; cy: number; x: number; y: number }> = {};
  let canvasH = 0;

  tiers.forEach((tier, ti) => {
    const y = tierStartY + ti * (NODE_H + TIER_GAP);
    const totalW = tier.length * NODE_W + (tier.length - 1) * 20;
    const startX = Math.max(10, (CANVAS_W - totalW) / 2);

    tier.forEach((agent, ai) => {
      const x = startX + ai * (NODE_W + 20);
      const cx = x + NODE_W / 2;
      const cy = y + NODE_H / 2;
      nodePositions[agent.id] = { cx, cy, x, y };

      const color = phaseColor(agent.phase);
      const initial = agent.name.charAt(0).toUpperCase();
      const statusDot = agent.success ? "#107c10" : "#a4262c";
      const sid = `s${sessionIdx}`;

      nodesHtml += `
        <div onclick="window.__selectNode('${sid}','${agent.id}')"
             id="node-${sid}-${agent.id}"
             style="position:absolute;left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px;
                    border-radius:8px;border:1px solid #e1dfdd;background:#fff;padding:8px;
                    cursor:pointer;text-align:center;transition:border-color 0.15s,box-shadow 0.15s;
                    box-sizing:border-box;">
          <div style="position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:${statusDot};"></div>
          <div style="width:26px;height:26px;border-radius:50%;background:${color};color:#fff;
                      font-size:11px;font-weight:700;display:inline-flex;align-items:center;
                      justify-content:center;margin-bottom:4px;">${initial}</div>
          <div style="font-size:12px;font-weight:600;color:#323130;line-height:1.2;">${agent.name}</div>
          <div style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;
                      color:#fff;background:${color};font-weight:600;margin-top:3px;">${agent.phase}</div>
          <div style="font-size:10px;color:#a19f9d;margin-top:3px;">${ms(agent.duration)} · ${tokenFmt(agent.tokens)}</div>
          ${agent.retries > 0 ? `<div style="position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);
              font-size:9px;background:#fef3cd;color:#856404;padding:0 5px;border-radius:8px;
              border:1px solid #ffc107;white-space:nowrap;">${agent.retries} retry</div>` : ""}
        </div>`;

      canvasH = Math.max(canvasH, y + NODE_H + 20);
    });
  });

  // Draw connection lines
  tiers.forEach((tier, ti) => {
    if (ti === 0) return;
    const prevTier = tiers[ti - 1];
    for (const agent of tier) {
      const to = nodePositions[agent.id];
      if (!to) continue;
      const parent = prevTier.find((p) => p.id === agent.parentId) || prevTier[0];
      const from = nodePositions[parent.id];
      if (!from) continue;

      linesHtml += `<line x1="${from.cx}" y1="${from.y + NODE_H}" x2="${to.cx}" y2="${to.y}"
                          stroke="#c8c6c4" stroke-width="1" marker-end="url(#ah-${sessionIdx})"/>`;
    }
  });

  // Draw retry loops (dashed amber curves from test tier back to build tier)
  const retriedAgents = session.agents.filter((a) => a.retries > 0);
  const testTier = tiers.length >= 3 ? tiers[tiers.length - 1] : null;
  if (testTier && retriedAgents.length > 0) {
    const testAgent = testTier[0];
    const testPos = nodePositions[testAgent?.id];
    if (testPos) {
      for (const ra of retriedAgents) {
        const raPos = nodePositions[ra.id];
        if (!raPos) continue;
        const cpx = Math.max(raPos.cx, testPos.cx) + 40;
        linesHtml += `<path d="M${testPos.cx + NODE_W / 2 - 10} ${testPos.cy}
                              C${cpx} ${testPos.cy}, ${cpx} ${raPos.cy}, ${raPos.cx + NODE_W / 2 - 10} ${raPos.cy}"
                            fill="none" stroke="#e6930a" stroke-width="1" stroke-dasharray="4 3"
                            marker-end="url(#ah-retry-${sessionIdx})"/>`;
      }
    }
  }

  // Validation gates row
  let gatesHtml = "";
  if (session.validationGates.length > 0) {
    const gy = canvasH + 10;
    const gateW = Math.min(120, (CANVAS_W - 20) / session.validationGates.length - 8);
    const totalGW = session.validationGates.length * gateW + (session.validationGates.length - 1) * 8;
    const gStartX = (CANVAS_W - totalGW) / 2;

    session.validationGates.forEach((g, gi) => {
      const gx = gStartX + gi * (gateW + 8);
      const icon = g.passed ? "✓" : "✗";
      const gColor = g.passed ? "#107c10" : "#a4262c";
      const gBg = g.passed ? "#dff6dd" : "#fef2f2";
      gatesHtml += `
        <div style="position:absolute;left:${gx}px;top:${gy}px;width:${gateW}px;
                    background:${gBg};border-radius:4px;padding:6px 8px;text-align:center;
                    border:1px solid ${g.passed ? "#c3e6cb" : "#f5c6cb"};">
          <div style="font-size:12px;font-weight:600;color:${gColor};">${icon} ${g.name}</div>
          <div style="font-size:10px;color:#605e5c;margin-top:2px;">${ms(g.duration)}</div>
        </div>`;
    });

    // Arrow from last tier to gates
    const lastTier = tiers[tiers.length - 1];
    if (lastTier.length > 0) {
      const lastAgent = lastTier[Math.floor(lastTier.length / 2)];
      const lp = nodePositions[lastAgent.id];
      if (lp) {
        linesHtml += `<line x1="${lp.cx}" y1="${lp.y + NODE_H}" x2="${CANVAS_W / 2}" y2="${gy}"
                            stroke="#c8c6c4" stroke-width="1" marker-end="url(#ah-${sessionIdx})"/>`;
      }
    }

    canvasH = gy + 50;
  }

  const svgH = canvasH + 20;

  return `
    <div style="border:1px solid #edebe9;border-radius:4px;margin-bottom:16px;overflow:hidden;">
      <div style="padding:10px 14px;background:#faf9f8;border-bottom:1px solid #edebe9;
                  display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-weight:600;font-size:13px;">Agent session</span>
          <span style="font-size:12px;color:#a19f9d;margin-left:10px;">${date}</span>
        </div>
        <span style="background:${statusBg};color:${statusColor};font-size:11px;padding:2px 8px;
                     border-radius:2px;font-weight:600;">${statusText}</span>
      </div>

      <div style="display:flex;gap:20px;padding:10px 14px;border-bottom:1px solid #f3f2f1;flex-wrap:wrap;">
        ${metricHtml("Duration", ms(session.totalDuration), "#0078d4")}
        ${metricHtml("Tokens", tokenFmt(session.totalTokens), "#8764b8")}
        ${metricHtml("Est. cost", estimateCost(session.totalTokens, session.model), "#038387")}
        ${metricHtml("Agents", String(session.agents.length), "#323130")}
        ${session.retryCount > 0 ? metricHtml("Retries", String(session.retryCount), "#e6930a") : ""}
        ${metricHtml("Model", session.model, "#605e5c")}
      </div>

      <div style="padding:10px 14px;">
        <div style="position:relative;width:${CANVAS_W}px;min-height:${svgH}px;margin:0 auto;">
          <svg style="position:absolute;top:0;left:0;width:${CANVAS_W}px;height:${svgH}px;pointer-events:none;"
               viewBox="0 0 ${CANVAS_W} ${svgH}" preserveAspectRatio="none">
            <defs>
              <marker id="ah-${sessionIdx}" viewBox="0 0 10 10" refX="8" refY="5"
                      markerWidth="5" markerHeight="5" orient="auto">
                <path d="M2 2L8 5L2 8" fill="none" stroke="#c8c6c4" stroke-width="1.5" stroke-linecap="round"/>
              </marker>
              <marker id="ah-retry-${sessionIdx}" viewBox="0 0 10 10" refX="8" refY="5"
                      markerWidth="5" markerHeight="5" orient="auto">
                <path d="M2 2L8 5L2 8" fill="none" stroke="#e6930a" stroke-width="1.5" stroke-linecap="round"/>
              </marker>
            </defs>
            ${linesHtml}
          </svg>
          ${nodesHtml}
          ${gatesHtml}
        </div>
      </div>

      <div id="detail-s${sessionIdx}" style="display:none;padding:14px;border-top:1px solid #edebe9;background:#faf9f8;">
        <div id="detail-content-s${sessionIdx}"></div>
      </div>
    </div>`;
}

function renderSimpleSession(session: AgentSession, sessionIdx: number): string {
  const agent = session.agents[0];
  const color = phaseColor(agent.phase);
  const date = new Date(session.timestamp).toLocaleString();

  return `
    <div style="border:1px solid #edebe9;border-radius:4px;margin-bottom:12px;">
      <div style="padding:10px 14px;display:flex;align-items:center;gap:10px;">
        <div style="width:28px;height:28px;border-radius:50%;background:${color};color:#fff;
                    font-size:12px;font-weight:700;display:flex;align-items:center;
                    justify-content:center;flex-shrink:0;">${agent.name.charAt(0).toUpperCase()}</div>
        <div style="flex:1;">
          <span style="font-size:13px;font-weight:600;color:#323130;">${agent.name}</span>
          <span style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;
                       color:#fff;background:${color};font-weight:600;margin-left:5px;">${agent.phase}</span>
          <div style="font-size:11px;color:#a19f9d;margin-top:2px;">${date}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:600;color:#323130;">${ms(agent.duration)}</div>
          <div style="font-size:11px;color:#a19f9d;">${tokenFmt(agent.tokens)} tokens · ${session.model}</div>
        </div>
        <div style="width:8px;height:8px;border-radius:50%;background:${agent.success ? "#107c10" : "#a4262c"};flex-shrink:0;"></div>
      </div>
      ${agent.tools.length > 0 ? `
        <div style="padding:4px 14px 10px;border-top:1px solid #f3f2f1;">
          ${agent.tools.map((t) => `<span style="font-family:'Cascadia Code',Consolas,monospace;font-size:10px;
              background:#f3f2f1;padding:1px 6px;border-radius:3px;margin-right:4px;color:#605e5c;">${t}</span>`).join("")}
        </div>` : ""}
    </div>`;
}

function metricHtml(label: string, value: string, color: string): string {
  return `
    <div>
      <div style="font-size:10px;color:#a19f9d;text-transform:uppercase;letter-spacing:0.3px;">${label}</div>
      <div style="font-size:16px;font-weight:700;color:${color};white-space:nowrap;">${value}</div>
    </div>`;
}

function renderDetailScript(): string {
  return `
    <script>
      window.__nodeData = window.__nodeData || {};
      window.__selectNode = function(sid, nodeId) {
        var panel = document.getElementById('detail-' + sid);
        var content = document.getElementById('detail-content-' + sid);
        if (!panel || !content) return;
        var prev = panel.getAttribute('data-active');
        if (prev === nodeId) {
          panel.style.display = 'none';
          panel.removeAttribute('data-active');
          var prevEl = document.getElementById('node-' + sid + '-' + nodeId);
          if (prevEl) { prevEl.style.borderColor = '#e1dfdd'; prevEl.style.boxShadow = 'none'; }
          return;
        }
        if (prev) {
          var prevEl2 = document.getElementById('node-' + sid + '-' + prev);
          if (prevEl2) { prevEl2.style.borderColor = '#e1dfdd'; prevEl2.style.boxShadow = 'none'; }
        }
        var el = document.getElementById('node-' + sid + '-' + nodeId);
        if (el) { el.style.borderColor = '#0078d4'; el.style.boxShadow = '0 0 0 2px rgba(0,120,212,0.15)'; }
        panel.setAttribute('data-active', nodeId);
        var data = (window.__nodeData[sid] || {})[nodeId];
        if (!data) { panel.style.display = 'none'; return; }
        var html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
          '<div style="width:24px;height:24px;border-radius:50%;background:' + data.color +
          ';color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;">' +
          data.initial + '</div>' +
          '<span style="font-size:15px;font-weight:600;">' + data.name + '</span>' +
          '<span style="font-size:10px;padding:1px 6px;border-radius:3px;color:#fff;background:' +
          data.color + ';font-weight:600;">' + data.phase + '</span></div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:14px;">';
        html += '<div><div style="font-size:10px;color:#a19f9d;text-transform:uppercase;">Duration</div><div style="font-size:14px;font-weight:600;">' + data.duration + '</div></div>';
        html += '<div><div style="font-size:10px;color:#a19f9d;text-transform:uppercase;">Tokens</div><div style="font-size:14px;font-weight:600;">' + data.tokens + '</div></div>';
        html += '<div><div style="font-size:10px;color:#a19f9d;text-transform:uppercase;">Model</div><div style="font-size:14px;font-weight:600;">' + data.model + '</div></div>';
        html += '<div><div style="font-size:10px;color:#a19f9d;text-transform:uppercase;">Files</div><div style="font-size:14px;font-weight:600;">' + data.files + '</div></div>';
        html += '</div>';
        if (data.tools && data.tools.length > 0) {
          html += '<div style="font-size:10px;color:#a19f9d;text-transform:uppercase;margin-bottom:4px;">Tools used</div>';
          html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">';
          for (var i = 0; i < data.tools.length; i++) {
            html += '<span style="font-family:Cascadia Code,Consolas,monospace;font-size:10px;background:#f3f2f1;padding:2px 6px;border-radius:3px;color:#605e5c;">' + data.tools[i] + '</span>';
          }
          html += '</div>';
        }
        if (data.description) {
          html += '<div style="font-size:10px;color:#a19f9d;text-transform:uppercase;margin-bottom:4px;">Actions taken</div>';
          html += '<div style="font-size:12px;color:#605e5c;line-height:1.5;padding:8px 10px;background:#fff;border-radius:4px;border:1px solid #edebe9;">' + data.description + '</div>';
        }
        content.innerHTML = html;
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    <\/script>`;
}

// ── Public render functions ──────────────────────────────────────────

export function renderTraces(workItemId: number, sessions: AgentSession[]): string {
  let nodeDataScript = "window.__nodeData = window.__nodeData || {};\n";

  const sessionsHtml = sessions.map((session, si) => {
    const sid = `s${si}`;
    const dataMap: Record<string, any> = {};

    for (const agent of session.agents) {
      dataMap[agent.id] = {
        name: agent.name,
        phase: agent.phase,
        color: phaseColor(agent.phase),
        initial: agent.name.charAt(0).toUpperCase(),
        duration: ms(agent.duration),
        tokens: tokenFmt(agent.tokens),
        model: agent.model,
        files: agent.filesChanged > 0 ? String(agent.filesChanged) : "—",
        tools: agent.tools,
        description: agent.description.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"),
      };
    }

    nodeDataScript += `window.__nodeData["${sid}"] = ${JSON.stringify(dataMap)};\n`;
    return renderFlowSession(session, si);
  }).join("");

  return `
    <div class="info-bar">
      <h3>Agent activity for WI ${workItemId}</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="conn"><span class="dot"></span> Connected to Application Insights</div>
        <button class="refresh-btn">↻ Refresh</button>
      </div>
    </div>
    ${sessionsHtml}
    <div style="font-size:11px;color:#a19f9d;font-style:italic;margin-top:8px;">
      ${sessions.length} session${sessions.length !== 1 ? "s" : ""} found
    </div>
    <script>${nodeDataScript}<\/script>
    ${renderDetailScript()}`;
}

export function renderEmpty(workItemId: number): string {
  return `
    <div class="info-bar">
      <h3>Agent activity for WI ${workItemId}</h3>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="conn"><span class="dot"></span> Connected to Application Insights</div>
        <button class="refresh-btn">↻ Refresh</button>
      </div>
    </div>
    <div class="empty">
      <div class="icon" style="font-size:48px;margin-bottom:12px;">&#128269;</div>
      <div style="font-size:14px;font-weight:600;color:#323130;margin-bottom:4px;">No agent traces found</div>
      <div>No Copilot agent sessions reference work item ${workItemId}.</div>
      <div style="margin-top:12px;font-size:12px;color:#605e5c;">
        Include the work item number in your prompt (e.g., "Ingest ADO User Story #${workItemId}")
        and ensure <code>captureContent</code> is enabled in your VS Code OTel settings.
      </div>
    </div>`;
}

export function renderError(message: string): string {
  return `<div class="error"><strong>Error:</strong> ${message}</div>`;
}

export function renderConfigWarning(): string {
  return `
    <div class="config-warning">
      <strong>Configuration required</strong>
      <p style="margin-top:8px;">
        The Copilot Agent Traces extension needs an Application Insights connection.
        Go to <strong>Project Settings → Agent Traces Settings</strong> and enter your
        App Insights Application ID and API Key.
      </p>
      <p style="margin-top:8px;font-size:12px;">
        To get these values: Azure Portal → Application Insights → API Access →
        copy the Application ID and create an API Key with "Read telemetry" permission.
      </p>
    </div>`;
}