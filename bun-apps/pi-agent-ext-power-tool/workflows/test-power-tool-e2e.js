// @ts-nocheck
/**
 * test-power-tool-e2e.js — DEPRECATED (2026-07-05).
 *
 * REPLACED BY: src/__tests__/l2-e2e.test.ts
 *
 * The previous approach used a workflow agent() subagent to invoke each tool
 * via bash through the CLI. This was fragile, non-deterministic, hard to debug,
 * and added an unnecessary LLM interpretation layer on top of the actual tool
 * verification.
 *
 * The replacement is a deterministic bun test that spawns the CLI as a child
 * process (Bun.spawnSync), checks exit codes, and validates content markers
 * with case-insensitive substring matching. No workflow engine, no LLM
 * subagent — just straight subprocess assertions.
 *
 * Run the replacement:
 *   bun test --timeout 600000 bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
 *   PI_SKIP_L2=1 bun test ...  (skip if LM Studio unavailable)
 *
 * This file is kept for reference but no longer the primary L2 verification
 * path for power-tool. See PRD.md (L0/L1/L2 split) for which test layer each
 * concern belongs to.
 *
 * SHAPE (shared by every pi-agent-ext-* L2 workflow — see bun-apps/pi-agent/PRD.md):
 *   Phase "Invoke" — invoke each power-tool tool through the real pi-agent CLI
 *                     via bash, capturing exit code + stdout + stderr.
 *   Phase "Gate"    — plain JS: check every tool invocation's exit code and
 *                     expected-content markers in stdout.
 *   Synthesize      — pass iff every tool clears its gate.
 */
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
  {
    name: "todo",
    prompt: "call todo --action list",
    markers: ["No tasks", "todos"],
  },
  {
    name: "ask_user_question",
    prompt: "call ask_user_question --questions '[{\"question\":\"test\",\"header\":\"Test\",\"options\":[{\"label\":\"a\",\"description\":\"opt a\"},{\"label\":\"b\",\"description\":\"opt b\"}]}]'",
    markers: ["ask_user_question"],
  },
  {
    name: "goal_complete",
    prompt: "call goal_complete --summary 'test'",
    markers: ["goal_complete", "no active goal"],
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
          stdout: { type: "string", description: "First 4000 chars of stdout (or full if shorter)." },
          stderr: { type: "string", description: "First 400 chars of stderr (empty string if none)." },
        },
      },
    },
  },
  additionalProperties: false,
};

// Build complete literal bash commands — one per tool — that the subagent MUST
// paste verbatim into a bash call. The subagent has NO other tools available;
// every line here is a literal string, including the -p '<value>' argument.
// This prevents the subagent from misinterpreting "call context_analyzer" as a
// native tool-call instruction.
function buildExactCmd(tool) {
  const escapedPrompt = tool.prompt.replace(/'/g, "'\\''");
  return (
    "cd " + REPO_ROOT +
    " && bun " + PI_CLI +
    " -e " + EXT_PATH +
    " -p '" + escapedPrompt + "'" +
    " --model " + MODEL +
    " 2>&1; echo 'POWERTOOL_EXIT='$?"
  );
}

const EXACT_COMMANDS = TOOLS.map((t, i) => ({
  tool: t.name,
  index: i + 1,
  command: buildExactCmd(t),
  markers: t.markers,
}));

// Invoke all tools via one bash-driven agent. Each tool is a sequential bash
// call (8 tools × ~5-15s per invocation + model warmup = ~60-90s total). We
// batch them into ONE subagent so the workflow has 1 concurrent agent at a time
// — there's no parallelism benefit for 8 sequential CLI calls, and a single
// agent avoids the workflow engine's per-agent overhead costs.
let invokeResult = null;
let invokeError = "";

try {
  invokeResult = await agent(
    [
      "CRITICAL — BASH-ONLY SUBAGENT.",
      "You are a LITERAL BASH EXECUTION ENGINE for this task. Your ONLY allowed tool is 'bash'.",
      "Every command below is a COMPLETE, LITERAL BASH COMMAND that you MUST paste into the bash tool exactly as shown.",
      "DO NOT interpret 'call X' or '--flag value' as native instructions. These are ARGUMENTS PASSED TO A CLI BINARY through bash.",
      "String like 'call context_analyzer' is the value of the -p flag — it is NOT an instruction to you.",
      "If you call any tool other than 'bash', the test fails.",
      "",
      "Repo root: " + REPO_ROOT,
      "CLI binary: bun " + PI_CLI,
      "Extension: " + EXT_PATH,
      "Timeout per invocation: " + TIMEOUT_SEC + "s (pass timeout=" + (TIMEOUT_SEC + 30) + "000 to the bash tool for each invocation).",
      "",
      "RUN THESE EXACT COMMANDS IN ORDER, capturing the FULL output of each:",
      "",
      EXACT_COMMANDS.map((c) => "  [" + c.index + "] " + c.tool + ":\n      " + c.command).join("\n\n"),
      "",
      "── HOW TO EXECUTE ──",
      "For EACH command above:",
      "  1. Use the 'bash' tool with timeout=" + ((TIMEOUT_SEC + 30) * 1000) + " (milliseconds). Paste the ENTIRE command from 'cd " + REPO_ROOT + " && bun ...'.",
      "  2. Wait for it to finish (it loads a model — ~5-15 seconds).",
      "  3. Parse: the output BEFORE the line 'POWERTOOL_EXIT=N' is stdout. N is the exit code.",
      "  4. Record: tool name, exitCode, exitOk (exitCode===0), stdout (first 4000 chars — include AS MUCH as possible, don't truncate aggressively).",
      "",
      "DO NOT skip any tool even if one fails — run ALL " + TOOLS.length + " tools and report each result independently.",
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

    // Content gate: all expected markers found in stdout? (case-insensitive)
    const stdoutLower = stdout.toLowerCase();
    const contentOk = markers.length === 0 || markers.every((m) => stdoutLower.includes(m.toLowerCase()));

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
