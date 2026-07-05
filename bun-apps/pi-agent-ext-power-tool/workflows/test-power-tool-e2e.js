// @ts-nocheck
/**
 * test-power-tool-e2e.js — canonical L2 regression e2e for pi-agent-ext-power-tool.
 *
 * SHAPE (shared by every pi-agent-ext-* L2 workflow — see bun-apps/pi-agent/PRD.md):
 *   Phase "Invoke" — invoke each power-tool tool through the real pi-agent CLI
 *                     via bash, capturing exit code + stdout + stderr.
 *   Phase "Gate"    — plain JS: check every tool invocation's exit code and
 *                     expected-content markers in stdout.
 *   Synthesize      — pass iff every tool clears its gate.
 *
 * WHY THIS CONTENT LIVES HERE (not in bun test)
 *   The question "does every power-tool tool register and run successfully under
 *   the real pi-agent runtime?" cannot be answered by a mock ExtensionAPI unit
 *   test. This workflow exercises the same CLI invocation path end users use.
 *   See PRD.md for the L0/L1/L2 split.
 *
 *   The deterministic surface (tool schema, parameter coercion, edge cases) is
 *   covered by bun-apps/pi-agent-ext-power-tool/src/__tests__/index.test.ts.
 *   This workflow only covers the integration regression layer.
 *
 * TODO Phase 3: after rpiv-todo is embedded as first-party code (Phase 1 of
 *   output/next-goal-20260705_000105.md), add a dedicated todo tool regression:
 *   - Registration: no name conflict with existing tools
 *   - Invoke /todos: no crash on empty state
 *   - State isolation: subsequent calls don't corrupt other tools' snapshots
 *
 * INVOCATION (unified runner)
 *   bash bun-apps/pi-agent/scripts/run-ext-e2e.sh power-tool
 *   # or directly via the workflow tool:
 *   bun-apps/pi-agent/run.sh -e workflow -p \
 *     "read bun-apps/pi-agent-ext-power-tool/workflows/test-power-tool-e2e.js and execute it via the workflow tool (background:false)"
 *
 * INPUTS (via the workflow tool's `args`)
 *   repoRoot  — repo root (default: cwd)
 *   piCli     — pi-agent CLI path    (default: <repoRoot>/bun-apps/pi-agent/src/cli.ts)
 *   extPath   — power-tool ext path  (default: <repoRoot>/bun-apps/pi-agent-ext-power-tool/src/index.ts)
 *   model     — model override for each invocation (default: google/gemma-4-26b-a4b-qat)
 *   timeout   — per-invocation timeout in seconds (default: 60)
 */
export const meta = {
  name: "test_power_tool_e2e",
  description:
    "L2 regression e2e for pi-agent-ext-power-tool: invoke every tool (context_analyzer, agent_inventory, extension_analyzer, knowledge_query, graph_health) through the real pi-agent CLI, verify exit code + expected-content markers in stdout. Pass = all tools clear their gate.",
  phases: [
    { title: "Invoke" },
    { title: "Gate" },
  ],
};

// ─── Inputs ──────────────────────────────────────────────────────────────────
const a = (typeof args === "object" && args) || {};
const REPO_ROOT = String(a.repoRoot || cwd);
const PI_CLI = String(a.piCli || REPO_ROOT + "/bun-apps/pi-agent/src/cli.ts");
const EXT_PATH = String(a.extPath || REPO_ROOT + "/bun-apps/pi-agent-ext-power-tool/src/index.ts");
const MODEL = String(a.model || "google/gemma-4-26b-a4b-qat");
const TIMEOUT_SEC = Number(a.timeout ?? 60);

// ─── Tool definitions ────────────────────────────────────────────────────────
// Each tool entry: name, prompt to invoke it, expected-content markers.
// Markers are substrings we expect in stdout for the invocation to be
// considered "content valid". An empty array = no content check (exit 0 only).
const TOOLS = [
  {
    name: "context_analyzer",
    prompt: "call context_analyzer",
    markers: ["context_analyzer", "System prompt", "Tools", "token", "cost"],
  },
  {
    name: "agent_inventory",
    prompt: "call agent_inventory --return-content true",
    markers: ["agent", "tools", "skills", "context_files", "model"],
  },
  {
    name: "extension_analyzer",
    prompt: "call extension_analyzer",
    markers: ["extensions", "tools", "findings", "severity"],
  },
  {
    name: "knowledge_query",
    prompt: "call knowledge_query --query test --topK 1",
    markers: [],     // content-agnostic: even "no results" is valid; exit 0 is the gate
  },
  {
    name: "graph_health",
    prompt: "call graph_health",
    markers: ["graph_health", "wiki", "links", "orphan", "MOC"],
  },
];

// ─── Phase 1: invoke each tool through the real pi-agent CLI ─────────────────
phase("Invoke");

const INVOKE_SCHEMA = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["tool", "exitCode", "exitOk"],
        properties: {
          tool: { type: "string", description: "Tool name." },
          exitCode: { type: "number", description: "Numeric exit code." },
          exitOk: { type: "boolean", description: "true if exitCode === 0." },
          stdout: { type: "string", description: "First 800 chars of stdout (or full if shorter)." },
          stderr: { type: "string", description: "First 400 chars of stderr (empty string if none)." },
        },
      },
    },
  },
  additionalProperties: false,
};

// Build a bash command that invokes one tool. We capture exit code + output:
//   timeout <s> bun <cli> -e <ext> -p <prompt> --model <model> 2>&1
// This approach (A) matches the flux2/krea2 pattern: bash each tool through
// the real CLI.  Each invocation is an independent pi-agent process.
function buildCmd(tool) {
  const escapedPrompt = tool.prompt.replace(/'/g, "'\\''");
  return (
    "cd " + REPO_ROOT +
    " && timeout " + TIMEOUT_SEC +
    " bun " + PI_CLI +
    " -e " + EXT_PATH +
    " -p '" + escapedPrompt + "'" +
    " --model " + MODEL +
    " 2>&1; echo 'POWERTOOL_EXIT='$?"
  );
}

// Invoke all tools via one bash-driven agent. Each tool is a sequential bash
// call (5 tools × ~3-5s per invocation + model warmup = ~30-45s total). We
// batch them into ONE subagent so the workflow has 1 concurrent agent at a time
// — there's no parallelism benefit for 5 sequential CLI calls, and a single
// agent avoids the workflow engine's per-agent overhead costs.
let invokeResult = null;
let invokeError = "";

try {
  invokeResult = await agent(
    [
      "Invoke ALL power-tool tools through the real pi-agent CLI and capture each result.",
      "Repo root: " + REPO_ROOT + ".",
      "CLI: bun " + PI_CLI,
      "Extension: " + EXT_PATH,
      "Model: " + MODEL,
      "Timeout per invocation: " + TIMEOUT_SEC + "s.",
      "",
      "For each tool (in order), run:",
      "  cd " + REPO_ROOT + " && timeout " + TIMEOUT_SEC + " bun " + PI_CLI + " -e " + EXT_PATH + " -p '<prompt>' --model " + MODEL + " 2>&1; echo 'POWERTOOL_EXIT='$?",
      "",
      "TOOLS TO INVOKE (in this exact order):",
      TOOLS.map((t, i) => "  " + (i + 1) + ". " + t.name + ": '" + t.prompt + "'").join("\n"),
      "",
      "After ALL 5 tools are done, return results[] — one entry per tool, in order.",
      "For each entry:",
      "  - tool: the tool name (exactly \"" + TOOLS.map((t) => t.name).join("\", \"") + "\")",
      "  - exitCode: the integer after POWERTOOL_EXIT=",
      "  - exitOk: exitCode === 0",
      "  - stdout: first 800 chars of the combined output (before the POWERTOOL_EXIT= line)",
      "  - stderr: \"\" (we merged 2>&1; leave empty)",
      "Each invocation loads pi-agent + the model — expect ~5-15s per tool. Use a long bash timeout (300s total for 5 tools is fine).",
      "DO NOT skip any tool even if one fails — run all 5 and report each result independently.",
    ].join("\n"),
    {
      label: "invoke-all-tools",
      phase: "Invoke",
      tier: "small",
      schema: INVOKE_SCHEMA,
    },
  );
} catch (e) {
  invokeError = (e && e.message) ? String(e.message) : String(e);
  invokeResult = null;
}

// ─── Phase 2: gate (pure JS, no agent) ──────────────────────────────────────
phase("Gate");

// Process results: extract structured verdicts, handle missing/incomplete data.
function processGates() {
  // Handle generation failure (no results at all).
  if (!invokeResult || !Array.isArray(invokeResult.results) || invokeResult.results.length === 0) {
    return {
      ok: false,
      error: "invoke phase returned no results" + (invokeError ? " (" + invokeError + ")" : ""),
      gates: TOOLS.map((t) => ({
        tool: t.name,
        invoked: false,
        exitOk: false,
        missing: true,
      })),
      summary: "INVOKE_PHASE_FAILED",
    };
  }

  const gates = invokeResult.results.map((r, i) => {
    const toolDef = TOOLS[i] || {};
    const markers = toolDef.markers || [];
    const stdout = (typeof r.stdout === "string") ? r.stdout : "";
    const exitOk = r.exitOk === true;

    // Content gate: all expected markers found in stdout?
    const contentOk = markers.length === 0 || markers.every((m) => stdout.includes(m));

    return {
      tool: r.tool || toolDef.name || ("tool_" + i),
      invoked: true,
      exitOk,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
      contentOk,
      expectedMarkers: markers,
      missingMarkers: markers.filter((m) => !stdout.includes(m)),
      // Pass = exit 0 AND all markers present
      pass: exitOk && contentOk,
    };
  });

  const passed = gates.filter((g) => g.pass);
  const failed = gates.filter((g) => !g.pass);
  const allPass = failed.length === 0;

  // Build a summary line
  let summary;
  if (!allPass) {
    const detail = failed.map((f) => {
      const reasons = [];
      if (!f.exitOk) reasons.push("exit " + f.exitCode);
      if (!f.contentOk) reasons.push("missing markers: " + f.missingMarkers.join(", "));
      return f.tool + " [" + reasons.join("; ") + "]";
    });
    summary = "FAILED: " + detail.join(" | ");
  } else {
    summary = "ALL_PASS (" + passed.length + "/" + TOOLS.length + " tools)";
  }

  return { ok: allPass, gates, passed, failed, summary };
}

const result = processGates();

// Log the gate result for debugging.
log("Gate result: " + result.summary);

// ─── Return ──────────────────────────────────────────────────────────────────
return {
  ok: result.ok,
  ext: "power-tool",
  tools: TOOLS.map((t) => t.name),
  gates: result.gates,
  summary: result.summary,
  // Carry the full invoke result for post-hoc debugging.
  invokeDetail: {
    resultsCount: (invokeResult && Array.isArray(invokeResult.results)) ? invokeResult.results.length : 0,
    error: invokeError || "",
  },
};
