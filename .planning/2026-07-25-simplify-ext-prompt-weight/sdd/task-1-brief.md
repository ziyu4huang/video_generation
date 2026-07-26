### Task 1: Probe harness — types + minimal runner + one probe + baseline

**Files:**
- Create: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts`
- Create: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts`
- Create: `scripts/probe-runner.ts`

**Interfaces:**
- Produces: `Probe` type + `runProbes(module, { baseline? })` → `ProbeResult[]` (the contract Phases 2–3 reuse).

- [ ] **Step 1: Write the probe + result types**

Create `.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts`:

```ts
/** A behavioral probe — one scenario to run + how to judge it. */
export interface Probe {
  id: string;
  phase: 1 | 2 | 3;
  /** The scenario prompt, handed to an isolated subagent. */
  prompt: string;
  /** Behavioral checklist — the judge scores each 0–3. */
  rubric: string[];
  /** Machine checks: each regex must match the subagent's transcript/output. */
  structural?: RegExp[];
}

/** One probe's scored outcome. */
export interface ProbeResult {
  id: string;
  rubricScores: number[];   // aligned to probe.rubric, 0–3 each
  structuralPassed: boolean;
  judgeNotes: string;
  output: string;           // the subagent's full output (for diffing)
}

/** Pass if every rubric item ≥ baseline − 1 (tolerance) AND structural passed. */
export function passed(result: ProbeResult, baseline: ProbeResult | undefined): boolean {
  if (!result.structuralPassed) return false;
  if (!baseline) return true;
  return result.rubricScores.every((s, i) => s >= (baseline.rubricScores[i] ?? 0) - 1);
}
```

- [ ] **Step 2: Write one concrete Phase-1 probe**

Create `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts`:

```ts
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
```

- [ ] **Step 3: Write the minimal runner**

Create `scripts/probe-runner.ts`. It reads a probe module path + an optional baseline path, dispatches each probe as an isolated subagent (so the probe sees the target config), then dispatches a judge subagent that scores the output against the rubric. Structural regexes run locally.

```ts
#!/usr/bin/env bun
// Usage:
//   bun scripts/probe-runner.ts <probe-module.ts>                 # run, print table
//   bun scripts/probe-runner.ts <probe-module.ts> --record <out>  # run, write baseline
//   bun scripts/probe-runner.ts <probe-module.ts> --baseline <in> # run, diff vs baseline
import { writeFileSync, readFileSync } from "node:fs";
import type { Probe, ProbeResult } from "../.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts";
import { passed } from "../.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts";

const probeModule = process.argv[2];
const { probes }: { probes: Probe[] } = await import(probeModule);
```

The runner body:

```ts
async function runProbe(p: Probe): Promise<ProbeResult> {
  // 1. Dispatch the probe as an isolated subagent (it inherits THIS session's
  //    config = the thing under test). Capture its output.
  const out = await dispatchSubagent({
    task: p.prompt,
    tools: ["subagent", "read", "bash", "grep", "find"], // probe needs to call subagent
    excludeTools: ["edit", "write"], // keep probes non-destructive
  });

  // 2. Structural checks (local, deterministic).
  const structuralPassed = (p.structural ?? []).every((re) => re.test(out));

  // 3. Judge: a second subagent scores the output vs the rubric (0–3 each).
  const judged = await dispatchSubagent({
    task:
      `You are grading an agent's response. Rubric (score each 0-3):\n` +
      p.rubric.map((r, i) => `${i}: ${r}`).join("\n") +
      `\n\nResponse to grade:\n"""\n${out.slice(0, 4000)}\n"""\n` +
      `Return JSON: {"scores":[...], "notes":"..."}. Only the JSON.`,
    schema: { type: "object", properties: {
      scores: { type: "array", items: { type: "number" } },
      notes: { type: "string" } }, required: ["scores", "notes"] },
  });
  const { scores, notes } = JSON.parse(judged);
  return { id: p.id, rubricScores: scores, structuralPassed, judgeNotes: notes, output: out };
}
```

`dispatchSubagent` is a thin wrapper over the `subagent` tool's `spawnSubagent` (import from `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts`). The main loop runs probes sequentially, builds a `ProbeResult[]`, prints a table, and either writes (`--record`) or diffs (`--baseline`) using `passed()`.

- [ ] **Step 4: Smoke-run the runner on Phase-1 probes and record the FAT baseline**

This run uses the CURRENT (un-slimmed) `subagent` tool — that is the fat baseline.

```bash
export PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight
bun scripts/probe-runner.ts \
  .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts \
  --record .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json
```
Expected: a score table printed; `baseline.json` written with 3 `ProbeResult`s, all `structuralPassed: true`.

- [ ] **Step 5: Commit**

```bash
git add .planning/2026-07-25-simplify-ext-prompt-weight/probes/ scripts/probe-runner.ts
git commit -m "feat(probes): behavioral probe harness + phase-1 baseline (fat subagent)"
```

---

