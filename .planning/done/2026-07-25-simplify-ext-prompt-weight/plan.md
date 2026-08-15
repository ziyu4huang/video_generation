# Simplify Extension Tool/Skill Prompt Weight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the per-request tools-schema tax and unload redundant skills across superpowers + wayfind, verified by behavioral A/B probes so behavior never silently regresses.

**Architecture:** Tiered (tool schemas → wayfind bodies → skill-unload audit). A shared probe harness (workflow + judge subagent + structural checks) is built first on the safest, highest-value target — the `subagent` tool's parameter schema (1,004 tok) — proving the empirical loop before any risky skill-removal decision. Each kept change passes its probe suite (thinned ≥ baseline − 1 per rubric item, zero structural regressions).

**Tech Stack:** TypeScript, typebox (`Type.Object` schema), Bun test runner, pi `workflow`/`subagent` tools, `@earendil-works/pi-coding-agent` `defineTool`.

## Global Constraints

- **ADR-0004:** the 14 superpowers `skills/*/SKILL.md` are byte-identical pinned (whole files incl. frontmatter). NEVER edit their content. A pinned file MAY stay on disk while *unregistered* (fidelity test stays green); unregister only after probes pass. Guard: `bun-apps/pi-agent-ext-superpowers/tests/skills-fidelity.test.ts`.
- **ADR-0005:** wayfind + superpowers stay separate, parallel packages. No merge, no cross-imports.
- **Editable surface only:** tool schemas (`pi-agent-ext-subagent`), wayfind `skills/*/SKILL.md` (no pin), pi-port glue (`references/*.md`, bootstrap `piBoundaryOverrides()`). All other `SKILL.md` are pinned.
- **Effort home:** `.planning/2026-07-25-simplify-ext-prompt-weight/`. Export `PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight` so helper scripts resolve here.
- **Shell discipline:** never top-level `cd`; use `( cd <dir> && ... )` or `--cwd`. Invoke python via `python/venv/bin/python`.
- **Frequent commits:** one commit per task (or per probe-verified sub-task).

---

## File Structure

**Created:**
- `.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts` — probe + result type definitions (shared by all phases).
- `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts` — Phase 1 probe fixtures.
- `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts` — Phase 2 probe fixtures.
- `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase3-skills.ts` — Phase 3 probe fixtures.
- `scripts/probe-runner.ts` — the harness: loads a probe module, dispatches each probe via the `subagent` tool in an isolated context, judges output vs rubric, runs structural checks, emits a score table + delta vs baseline.
- `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts` — pins the slimmed schema (all params present/typed + token-budget ceiling).
- `bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts` — pins wayfind description weights (Phase 2).

**Modified:**
- `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` — slim `subagentToolSchema` per-param descriptions (Phase 1).
- `bun-apps/pi-agent-ext-subagent/src/subagent-runs-tool.ts` — slim `subagent_runs` schema (Phase 1).
- `bun-apps/pi-agent-ext-wayfind/skills/{domain-modeling,grilling,grill-memory}/SKILL.md` — thin descriptions + bodies (Phase 2).
- `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — add a `SKILL_EXCLUDE` knob for unregistering pinned skills (Phase 3; file content untouched).

**Recorded (committed, not gitignored):**
- `.planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json` — fat-config probe scores, recorded once.

---

## Phase 1 — Probe harness + `subagent` schema slim (guaranteed ~550 tok/req floor)

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

### Task 2: Slim the `subagent` + `subagent_runs` tool schemas (TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (the `subagentToolSchema` descriptions)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-runs-tool.ts`

**Interfaces:**
- Consumes: `subagentToolSchema` (current 16-param Type.Object).
- Produces: same 16 params, same types/optionality — only `description` strings shrink.

- [ ] **Step 1: Write the failing weight + shape test**

Create `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { subagentToolSchema } from "../src/subagent-tool.ts";

const PARAMS = (subagentToolSchema as any).properties as Record<string, { type: string; description: string }>;
const EXPECTED = [
  "agent","agentType","task","model","tier","cwd","tools","excludeTools",
  "timeoutMs","tokenBudget","spendBudget","retryOnTransient","commitScope","schema","schemaRepairAttempts",
];

describe("subagent tool schema — slimmed weight", () => {
  it("keeps every parameter with its optionality and type", () => {
    for (const name of EXPECTED) {
      expect(PARAMS[name], `missing param ${name}`).toBeDefined();
    }
    // task is required; all others optional
    const required = (subagentToolSchema as any).required as string[];
    expect(required).toEqual(["task"]);
  });

  it("each description is terse (< 240 chars) — was up to ~360", () => {
    for (const name of EXPECTED) {
      const len = PARAMS[name].description.length;
      expect(len, `${name} desc ${len} chars`).toBeLessThan(240);
    }
  });

  it("preserves load-bearing semantic warnings (not just truncated)", () => {
    const joined = Object.values(PARAMS).map((p) => p.description).join("\n");
    // These phrases MUST survive the slim — they prevent real misuse.
    expect(joined).toContain("NO access to this session's history");   // task
    expect(joined).toContain("only pass a model you know is configured"); // model
    expect(joined).toContain("never auto-reverts");                    // commitScope
    expect(joined).toContain("non-recoverable");                       // tokenBudget
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Expected: FAIL — current descriptions exceed 240 chars (e.g. `commitScope` ~510 chars) and the load-bearing phrases check may pass already (they exist) but the length ceiling fails.

- [ ] **Step 3: Slim the descriptions**

In `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, replace each `description:` in `subagentToolSchema` with the terse form (semantics identical, every load-bearing phrase preserved):

```ts
agent:          "Role label (e.g. 'reviewer'); forwarded as an instructions prefix, doesn't change tool selection.",
agentType:      "Named agent def (.pi/agents/<name>.md) binding tools/model/prompt/worktree-isolation. Explicit model/tools/excludeTools here override the binding.",
task:           "Full self-contained prompt — the child has NO access to this session's history (include goal, context, constraints, return format).",
model:          "Model override `provider/model-id`. Prefer omitting (uses the session's current model) or set `tier`; an unauthed id warns and falls back. Only pass a model you know is configured.",
tier:           "Model tier: 'small'|'medium'|'big'. Omit to inherit the session model; explicit `model` takes priority.",
cwd:            "Child working directory (defaults to parent session cwd).",
tools:          "Tool allowlist, e.g. ['read','grep','find','ls'] for read-only. Omit for the default coding toolset.",
excludeTools:   "Tools to deny after the allowlist, e.g. ['edit','write'].",
timeoutMs:      "Abort after this many ms (wall-clock). Omit for no timeout.",
tokenBudget:    "Abort once cumulative token usage exceeds this (bounds a looping child timeoutMs can't catch; per-turn check, may overshoot one turn; non-recoverable).",
spendBudget:    "Abort once cumulative cost ($) exceeds this (pairs with tokenBudget; same per-turn check).",
retryOnTransient:"Retry once on transient failure (timeout/network/rate-limit/schema). Default true.",
commitScope:    "Commit-path allowlist (prefix-matched). After the run, flags any committed path outside this scope as a ⚠ violation (detection only, never auto-reverts; best-effort). Use [] to flag any commit. Ignored for worktree-isolated runs.",
schema:         "JSON Schema for the child's final answer; when set, the child returns via structured_output and the result is the JSON-serialized object.",
schemaRepairAttempts: "Max repair re-prompts when the child returns prose instead of structured_output (default 2). Bump for models that emit structured output unreliably.",
```

Then apply the same terse-edit pass to `subagent_runs` params in `src/subagent-runs-tool.ts` (target each `description` < 200 chars; preserve the action enum semantics).

- [ ] **Step 4: Run the weight test — verify it passes**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Expected: PASS — all params present, `required: ["task"]`, every description < 240 chars, load-bearing phrases present.

- [ ] **Step 5: Run the full subagent suite — verify no behavioral regression**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test )
```
Expected: all green incl. `regression-subagent-contract.test.ts` (pins behavior, not description prose) + `extension-subagent-registration.test.ts`.

- [ ] **Step 6: Measure the token drop**

```bash
bun scripts/probe-runner.ts --self-test-schema 2>/dev/null || true
# Authoritative: rebuild + inspect
( cd bun-apps && bun install )
bun --cwd bun-apps/pi-agent run inspect:extensions 2>/dev/null || \
  bun -e 'console.log("re-run inspect_extensions after rebuild to confirm subagent ~1004 -> ~450 tok")'
```
Expected: `subagent` tool drops from ~1,004 to ~450 tok.

- [ ] **Step 7: Commit**

```bash
( cd bun-apps/pi-agent-ext-subagent && git add src/subagent-tool.ts src/subagent-runs-tool.ts tests/subagent-schema-weight.test.ts && \
  git commit -m "refactor(subagent): slim tool param descriptions (~550 tok/req)" )
```

---

### Task 3: Phase-1 behavioral probes — verify the slimmed tool is still used correctly

**Files:** none modified — this task RUNS the harness and decides keep/revert.

- [ ] **Step 1: Run the Phase-1 probes against the slimmed tool, diff vs baseline**

```bash
export PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight
bun scripts/probe-runner.ts \
  .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts \
  --baseline .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json
```
Expected: every probe `PASSED` (rubric ≥ baseline − 1 per item, `structuralPassed: true`).

- [ ] **Step 2: Decision gate**

- All pass → Phase 1 complete; record the thinned scores alongside baseline, commit the result log.
- Any fail → the slim went too far on that param; restore the specific load-bearing phrasing (re-run Task 2 Step 3 for just that param) until probes pass. Do NOT revert the whole schema.

- [ ] **Step 3: Commit the result log**

```bash
git add .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-results.md
git commit -m "test(probes): phase-1 subagent probes pass vs baseline (slimmed schema)"
```

---

## Phase 2 — wayfind skill bodies + descriptions (editable; no pin)

### Task 4: Thin wayfind descriptions + verbose bodies; probe; keep/revert

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/domain-modeling/SKILL.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/grill-memory/SKILL.md`
- Create: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts`

**Interfaces:**
- Consumes: the Phase-1 harness `runProbes` + `passed`.
- Produces: thinned wayfind skills (always-on description ≤ ~150 chars each; bodies keep the load-bearing trigger logic + ADR/examples).

- [ ] **Step 1: Write the weight test (description ceiling) + Phase-2 probes**

`bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts` asserts each target skill's `description:` frontmatter line is ≤ 150 chars AND still contains its trigger noun (domain-modeling → "ubiquitous language" or "glossary"; grilling → "grill"; grill-memory → "grill_decision" or "memory"). Phase-2 probes (`phase2-wayfind.ts`) cover: grill a 2-option decision; model a 3-term domain; entry-path routing.

- [ ] **Step 2: Run — verify weight test fails (current descriptions ~218–224 tok / long)**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skill-weight.test.ts )
```
Expected: FAIL on the 150-char ceiling.

- [ ] **Step 3: Thin the three descriptions + trim verbose body sections**

For each of `domain-modeling`, `grilling`, `grill-memory`: shorten the frontmatter `description:` to ≤ 150 chars (keep the trigger noun); in the body, cut redundant preamble/restatement but KEEP every checklist item, example, and the trigger phrase (those are what make the skill fire). This is TDD-edit-by-edit: after each file, re-run the weight test.

- [ ] **Step 4: Run weight test + full wayfind suite**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )
```
Expected: all green.

- [ ] **Step 5: Record fat baseline + run Phase-2 probes, diff**

Record baseline from a pre-edit checkout if not already captured, then:
```bash
bun scripts/probe-runner.ts .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts \
  --baseline .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline-wayfind.json
```
Expected: all `PASSED`. Revert any skill whose probe regresses.

- [ ] **Step 6: Commit**

```bash
( cd bun-apps/pi-agent-ext-wayfind && git add skills tests && git commit -m "refactor(wayfind): slim skill descriptions/bodies (probes pass)" )
git add .planning/2026-07-25-simplify-ext-prompt-weight/probes/
git commit -m "test(probes): phase-2 wayfind probes pass vs baseline"
```

---

## Phase 3 — "LLM already knows" skill-unload audit (true A/B)

### Task 5: Add the A/B manifest-swap mode + superpowers `SKILL_EXCLUDE` knob

**Files:**
- Modify: `scripts/probe-runner.ts` — add `--manifest <path>` (runs probes under that extension manifest; two runs = A/B).
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — read `PI_SUPERPOWERS_SKILL_EXCLUDE` (comma-list) when enumerating skills; excluded skills' `SKILL.md` stay on disk (fidelity intact) but are not registered.

- [ ] **Step 1: Locate the skill-enumeration code**

```bash
grep -nE "readdir|glob|skills/|SKILL.md|registerSkill|loadSkills" bun-apps/pi-agent-ext-superpowers/src/superpowers.ts | head
```
Identify the single function that lists `skills/*/SKILL.md`.

- [ ] **Step 2: Write the failing test — exclude knob drops a skill from registration but leaves the file**

`bun-apps/pi-agent-ext-superpowers/tests/skill-exclude.test.ts`: with `PI_SUPERPOWERS_SKILL_EXCLUDE=test-driven-development`, the registered skill list omits it; the file `skills/test-driven-development/SKILL.md` still exists and matches the fixture (fidelity untouched).

- [ ] **Step 3: Implement the knob**

In the enumeration function: `const exclude = (process.env.PI_SUPERPOWERS_SKILL_EXCLUDE ?? "").split(",").filter(Boolean);` then `if (exclude.includes(skillDirName)) continue;`. The file is never touched.

- [ ] **Step 4: Run — verify**

```bash
( cd bun-apps/pi-agent-ext-superpowers && PI_SUPERPOWERS_SKILL_EXCLUDE=test-driven-development bun test tests/skill-exclude.test.ts && bun test )
```
Expected: exclude test PASS; full suite (incl. skills-fidelity) green.

- [ ] **Step 5: Commit**

```bash
( cd bun-apps/pi-agent-ext-superpowers && git add src/superpowers.ts tests/skill-exclude.test.ts && \
  git commit -m "feat(superpowers): PI_SUPERPOWERS_SKILL_EXCLUDE knob (unregister, file stays pinned)" )
```

### Task 6: Probe-unload each candidate skill; unregister only zero-regression winners

**Candidates:** `test-driven-development`, `systematic-debugging`, `brainstorming`, `verification-before-completion`.

**Files:**
- Create: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase3-skills.ts`
- Possibly modify: `bun-apps/pi-agent/run-dir/manifest.json` (or a startup env) to default-exclude proven winners.

- [ ] **Step 1: Write Phase-3 probes (one set per candidate)**

`phase3-skills.ts` — per candidate, 2–3 probes asserting the behavior the skill teaches:
- TDD: "add feature X to <file>" → rubric: writes a failing test first, runs it, then implements.
- systematic-debugging: "this test fails unexpectedly, fix it" → rubric: forms a hypothesis before editing; reads the failing output; doesn't blind-patch.
- brainstorming: "let's build a settings page" → rubric: explores intent/asks before coding.
- verification-before-completion: "is it done?" after partial work → rubric: runs verification commands before claiming success.

- [ ] **Step 2: For each candidate, run A/B (fat vs excluded) and diff**

```bash
export PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight
for SKILL in test-driven-development systematic-debugging brainstorming verification-before-completion; do
  echo "=== A/B: $SKILL ==="
  bun scripts/probe-runner.ts .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase3-skills.ts \
    --filter "$SKILL" --baseline <(fat-run) --thin-env PI_SUPERPOWERS_SKILL_EXCLUDE=$SKILL
done
```
Expected per candidate: a delta table. Keep/unload decision per the `passed()` gate.

- [ ] **Step 3: Decision gate — unregister only zero-regression winners**

For each candidate that passes (thinned ≥ baseline − 1, zero structural regressions): add it to the default `PI_SUPERPOWERS_SKILL_EXCLUDE` (or a curated list in `superpowers.ts`). For any that regresses: leave it loaded, note why in the results log.

- [ ] **Step 4: Verify fidelity + full suite green**

```bash
( cd bun-apps/pi-agent-ext-superpowers && bun test )   # skills-fidelity MUST stay green
bun test bun-apps/pi-agent/src/__tests__/extension-contract.test.ts
```
Expected: all green. The pinned files are byte-identical (unregister ≠ edit).

- [ ] **Step 5: Commit + final token measurement**

```bash
git add .planning/2026-07-25-simplify-ext-prompt-weight/probes/ bun-apps/pi-agent-ext-superpowers/
git commit -m "feat(superpowers): unload LLM-already-knows skills (proven by A/B probes)"
# Measure final per-request tax
bun -e '/* re-run inspect_context: report new tools-schema total vs 12,370 baseline */'
```

---

## Verification (whole effort)

- [ ] `skills-fidelity.test.ts` green throughout (ADR-0004 never broken — pinned files untouched).
- [ ] `extension-contract.test.ts` green throughout (every extension still loads + wires).
- [ ] Every package `bun test` green.
- [ ] Every kept change has a probe result log showing PASSED vs baseline.
- [ ] `inspect_context` shows tools-schema total reduced from ~12,370 tok (Phase-1 floor ~−550; more from Phases 2–3).
- [ ] `grep -rE "\.superpowers/"` still only deliberate fallbacks (this effort doesn't touch them).
