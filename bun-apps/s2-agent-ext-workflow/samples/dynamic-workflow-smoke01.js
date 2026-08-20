/**
 * dynamic-workflow-smoke01.js — minimal end-to-end smoke test.
 *
 * Runs the workflow runtime directly (NOT through the pi TUI): one phase,
 * two tiny agents run in parallel, a deterministic join. Use it to verify
 * the dynamic-workflows extension loads, an agent() round-trips against a
 * real model, and parallel()/return wiring works — in seconds, not minutes.
 *
 * Run it from the repo root:
 *   bun bun-apps/s2-agent-ext-workflow/samples/run.ts \
 *     bun-apps/s2-agent-ext-workflow/samples/dynamic-workflow-smoke01.js
 *
 * (This file is a workflow SCRIPT: agent/phase/log/parallel are globals
 * injected by the runtime — do not import them, do not run this file with
 * `bun` directly. Feed it through samples/run.ts or the `workflow` tool.)
 */
export const meta = {
  name: "smoke01",
  description: "Minimal smoke: two parallel agents echo a token, workflow joins them",
  phases: [{ title: "Smoke" }],
};

phase("Smoke");

// Two independent micro-agents fan out in parallel — the smallest possible
// parallel()/fan-in shape. Trivial prompts so a small model finishes fast.
const [a, b] = await parallel([
  () => agent("Reply with exactly this single word and nothing else: FOO", { label: "echo-foo" }),
  () => agent("Reply with exactly this single word and nothing else: BAR", { label: "echo-bar" }),
]);

log(`agents returned: a=${String(a).trim()} b=${String(b).trim()}`);

return { ok: true, a: String(a).trim(), b: String(b).trim() };
