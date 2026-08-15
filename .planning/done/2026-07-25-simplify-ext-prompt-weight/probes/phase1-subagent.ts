/**
 * Phase-1 probe fixtures — the `subagent` tool schema slim target.
 *
 * These three probes exercise the behaviors the (un-slimmed → slimmed) `subagent`
 * tool must keep enabling: read-only dispatch, implementer dispatch, and run
 * recall. The FAT baseline is recorded once against the current verbose schema;
 * Phase 3 (Task 3) re-runs these vs that baseline to prove the slim introduced
 * no behavioral regression.
 *
 * Run via:
 *   bun scripts/probe-runner.ts \
 *     .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts \
 *     --record .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json
 */
import type { Probe } from "./types.ts";

export const probes: Probe[] = [
  {
    id: "subagent-dispatch-readonly",
    phase: 1,
    prompt:
      "I need to understand the auth flow in this repo without modifying anything. Dispatch a read-only subagent to map the entry points and report back a short summary. Do the dispatch yourself; don't explore by hand.",
    rubric: [
      "invokes the `subagent` tool (not bash/workflow)",
      "passes a self-contained task the child can act on without session history",
      "restricts the child to read-only (tools allowlist or excludeTools)",
    ],
    structural: [/\bsubagent\b/i],
  },
  {
    id: "subagent-dispatch-implementer",
    phase: 1,
    prompt:
      "Add a tiny `health()` function returning `{ ok: true }` to a scratch file. Dispatch one subagent to implement it and report what it did.",
    rubric: [
      "invokes the `subagent` tool",
      "task prompt is self-contained (names the file + the signature)",
    ],
    structural: [/\bsubagent\b/i],
  },
  {
    id: "subagent-recall",
    phase: 1,
    prompt: "What subagent runs have happened recently? Show me how to look them up.",
    rubric: ["mentions the subagent_runs tool or /subagents", "does not invent run ids"],
    structural: [/subagent_runs|\/subagents/i],
  },
];
