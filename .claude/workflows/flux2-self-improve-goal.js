// @ts-nocheck
/**
 * flux2-self-improve-goal.js — /goal-driven wrapper for the flux2 self-improve loop.
 *
 * PURPOSE
 *   This is the pi-goal integration bridge for Priority C (Post-Phase-3 reflection).
 *   It wraps the existing synchronous driver (self-improve-loop.driver.ts) so the
 *   pi-agent can run it inside a `/goal` session and call `goal_complete` with the
 *   structured result — turning the loop from a standalone bash script into a
 *   /goal-orchestrated autonomous iteration.
 *
 * INVOCATION (inside a pi-agent session with an active /goal):
 *
 *   /goal start "self-improve flux2 pose L3-01" --tokens 200k
 *
 *   Then the agent loads this workflow and calls the workflow tool with:
 *     { poseId: "L3-01", seed: 42, attempts: 5, ... }
 *
 *   The workflow runs the existing synchronous driver via bash, captures
 *   LOOP_RESULT, and returns structured data. The agent then calls:
 *     goal_complete({summary: "...converged after 2/5 attempts..."})
 *
 * DATA FLOW
 *
 *   /goal session
 *     │
 *     ├─ agent reads this workflow source
 *     ├─ agent calls workflow tool with args
 *     │     │
 *     │     └─ agent(-) calls bash → run-self-improve-loop.sh args...
 *     │           │
 *     │           └─ (subshell) bun driver.ts --args '<json>'
 *     │                 │
 *     │                 └─ runWorkflow(self-improve-flux2.js, args)
 *     │                       │ returns LOOP_RESULT
 *     │                       └─ printed to stdout by driver
 *     │
 *     ├─ agent reads workflow return value {converged, summary, ...}
 *     ├─ agent calls goal_complete({summary})
 *     └─ /goal complete
 *
 * WHY THIS APPROACH
 *   - Does NOT modify the existing battle-tested loop files
 *     (run-self-improve-loop.sh, self-improve-loop.driver.ts,
 *      self-improve-flux2.js)
 *   - The workflow is a thin meta-wrapper that only handles bash orchestration
 *     + LOOP_RESULT parsing — zero model calls of its own
 *   - The synchronous driver already handles all GPU inference + VLM judging
 *     + convergence gating; this workflow just bridges it into the /goal system
 *   - Token budget (--tokens 200k) protects against the loop burning unbounded
 *     inference tokens in an agent session
 *
 * SAFETY
 *   - Propose-only: the wrapped loop already NEVER git-applies, edits source,
 *     or merges. This wrapper only passes through the loop's own return value.
 *   - Timeout-aware: the `timeout` setting in agent() must allow for GPU
 *     inference. A pose loop at 3 attempts × 2min/generation + 1min/judge ≈
 *     3 × 3min = 9min minimum. Recommend a 20min timeout or use nohup+poll.
 *   - Non-destructive: does not touch any existing file in the repository.
 */

export const meta = {
  name: "flux2_self_improve_goal",
  description:
    "Wraps the existing synchronous flux2 self-improve loop driver for execution inside a /goal session. Accepts the same flags as run-self-improve-loop.sh (poseId, seed, attempts, steps, width, height, mode, prompt, judgeModel, consecutiveStatic, seeds). Runs the driver via bash, captures LOOP_RESULT, and returns structured data {converged, summary, winnerPath, attemptsUsed, needsReview, staticExit, terminationReason} so the calling agent can call goal_complete. No model calls of its own — a thin meta-wrapper.",
  whenToUse:
    "Use inside a pi-agent session with an active /goal to run the flux2 self-improve loop as a /goal-orchestrated autonomous iteration. The calling agent uses the returned structured data to call goal_complete, closing the self-improve loop within the /goal system. For ad-hoc (non-/goal) runs, use run-self-improve-loop.sh directly.",
  phases: [
    { title: "Resolve", detail: "Resolve repo root, venv, binary, and construct args" },
    { title: "Run Loop", detail: "Run the synchronous driver via bash, parse LOOP_RESULT" },
    { title: "Report", detail: "Return structured data for goal_complete" },
  ],
};

// ─── Resolve: normalize args ─────────────────────────────────────────────────
phase("Resolve");

const a = (typeof args === "object" && args) || {};
const REPO_ROOT = String(a.repoRoot || cwd || "");
if (!REPO_ROOT) {
  throw new Error("flux2-self-improve-goal: REPO_ROOT could not be resolved");
}

// Forwarded flags — mirror run-self-improve-loop.sh's flag set exactly.
// When undefined/null, the flag is omitted and the bash script uses its default.
const POSE_ID = a.poseId || "";
const SEED = a.seed != null ? Number(a.seed) : undefined;
const STEPS = a.steps != null ? Number(a.steps) : undefined;
const WIDTH = a.width != null ? Number(a.width) : undefined;
const HEIGHT = a.height != null ? Number(a.height) : undefined;
const ATTEMPTS = a.attempts != null ? Number(a.attempts) : undefined;
const MODE = a.mode || "";
const PROMPT = a.prompt || "";
const JUDGE_MODEL = a.judgeModel || "";
const CONSECUTIVE_STATIC = a.consecutiveStatic != null ? Number(a.consecutiveStatic) : undefined;
const SEEDS = a.seeds || []; // number[]

const SCRIPT = REPO_ROOT + "/bun-apps/pi-agent/scripts/run-self-improve-loop.sh";

// Build the bash command. We apply --pose-id only when non-empty; --prompt
// only when non-empty (they are mutually exclusive in the script). All other
// flags are applied only when explicitly set.
const parts = ["bash", JSON.stringify(SCRIPT)];
if (POSE_ID) { parts.push("--pose-id", JSON.stringify(POSE_ID)); }
if (PROMPT) { parts.push("--prompt", JSON.stringify(PROMPT)); }
if (SEED != null) { parts.push("--seed", String(SEED)); }
if (STEPS != null) { parts.push("--steps", String(STEPS)); }
if (WIDTH != null) { parts.push("--width", String(WIDTH)); }
if (HEIGHT != null) { parts.push("--height", String(HEIGHT)); }
if (ATTEMPTS != null) { parts.push("--attempts", String(ATTEMPTS)); }
if (MODE) { parts.push("--mode", JSON.stringify(MODE)); }
if (JUDGE_MODEL) { parts.push("--judge-model", JSON.stringify(JUDGE_MODEL)); }
if (CONSECUTIVE_STATIC != null) { parts.push("--consecutive-static", String(CONSECUTIVE_STATIC)); }
if (SEEDS.length > 0) { parts.push("--seeds", SEEDS.join(",")); }

const BASH_CMD = parts.join(" ");

log(
  "flux2 self-improve goal: " + (POSE_ID ? "pose=" + POSE_ID : PROMPT ? "prompt" : "default")
  + (ATTEMPTS ? ", attempts=" + ATTEMPTS : "")
  + ", mode=" + (MODE || "best-of-n")
);

// ─── Run Loop: execute the synchronous driver, capture LOOP_RESULT ──────────
phase("Run Loop");

const LOOP_RESULT_SCHEMA = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean", description: "true if LOOP_RESULT was successfully parsed from the driver output" },
    converged: { type: "boolean", description: "true if the loop converged (all atoms passed)" },
    needsReview: { type: "boolean", description: "true if the loop completed but did not converge (best-effort result)" },
    staticExit: { type: "boolean", description: "true if loop exited due to plateau (identical failed-atom signature)" },
    terminationReason: { type: "string", description: "converged | static | exhausted" },
    winnerPath: { type: "string", description: "Path to the winning generated PNG" },
    attemptsUsed: { type: "integer", description: "How many attempts the loop ran" },
    maxAttempts: { type: "integer", description: "Maximum allowed attempts" },
    summary: { type: "string", description: "Human-readable summary of the loop result, suitable for goal_complete" },
    error: { type: "string", description: "Error message if ok=false" },
    rawTail: { type: "string", description: "Last 500 chars of driver stderr for debugging" },
    _poseId: { type: "string", description: "The pose id passed in (passthrough for reference)" },
  },
  additionalProperties: false,
};

const loopResult = await agent(
  [
    "Run the flux2 self-improve loop synchronously and parse LOOP_RESULT from its output.",
    "",
    "COMMAND:",
    "  cd " + JSON.stringify(REPO_ROOT),
    "  " + BASH_CMD,
    "",
    "PROTOCOL:",
    "  1. The script runs a sync driver that may take 5-30min (GPU inference). Use a 40min timeout.",
    "  2. It prints 'LOOP_RESULT <json>' on its LAST stdout line.",
    "  3. If the command exits 0, LOOP_RESULT was produced (converged OR needsReview — both are valid results).",
    "  4. If the command exits non-zero, the loop crashed — capture the error tail.",
    "  5. ALSO capture the last 500 chars of stderr (driver[driver] prefixed lines) for debugging.",
    "",
    "PARSE LOOP_RESULT:",
    "  - grep the stdout for '^LOOP_RESULT ' and parse the JSON after that prefix",
    "  - The JSON has fields: ok, converged, attemptsUsed, maxAttempts, winnerPath, needsReview,",
    "    staticExit, terminationReason, summary, best, trace, ...",
    "  - Set your result's ok=true if LOOP_RESULT was found and parsed; false if the loop crashed",
    "    (command non-zero with no LOOP_RESULT).",
    "",
    "BUILD SUMMARY (for goal_complete):",
    "  - converged: 'Converged: <summary from LOOP_RESULT>'",
    "  - static: 'Static exit after <N>/<M> attempts: identical failed-atom signature <sig>'",
    "  - exhausted: 'Exhausted after <N>/<M> attempts: best had <K> failed atoms, meanFaith=<F>'",
    "  - crashed: 'Crashed: <error>'",
    "",
    "Return the parsed result.",

    // Context for the agent
    "Pose: " + JSON.stringify(POSE_ID || PROMPT || "(default)"),
    "Script: " + SCRIPT,
    "Args: attempts=" + (ATTEMPTS ?? 3) + ", seed=" + (SEED ?? 42) + ", mode=" + (MODE || "best-of-n"),
  ].join("\n"),
  {
    label: "run flux2 self-improve loop (synchronous driver)",
    tier: "small",
    schema: LOOP_RESULT_SCHEMA,
    // GPU inference loop — a single pose at 3 attempts × (2min gen + 1min judge)
    // = ~9min minimum. Setting 40min to be safe for 5-attempt runs with retries.
    timeout: 2400, // 40 minutes
  },
);

const verified = loopResult || { ok: false, error: "agent returned no result", rawTail: "" };

// ─── Report: structured return for the calling agent's goal_complete ────────
phase("Report");

// Surface a clean, structured return. The calling agent (in the /goal session)
// will read these fields and call goal_complete({summary}).
return {
  ok: verified.ok,
  converged: !!verified.converged,
  needsReview: !!verified.needsReview,
  staticExit: !!verified.staticExit,
  terminationReason: verified.terminationReason || (verified.ok ? "unknown" : "crashed"),
  winnerPath: verified.winnerPath || "",
  attemptsUsed: verified.attemptsUsed ?? 0,
  maxAttempts: verified.maxAttempts ?? (ATTEMPTS ?? 3),
  summary: verified.summary || "",
  poseId: POSE_ID || "",
  prompt: PROMPT || "",
  error: verified.error || "",
  rawTail: verified.rawTail || "",
  // Convention: the calling agent calls goal_complete({summary: result.summary}).
  // The summary is pre-formatted for goal_complete — it starts with "Converged:"/
  // "Static exit:"/"Exhausted:"/"Crashed:" and includes the key metrics.
};
