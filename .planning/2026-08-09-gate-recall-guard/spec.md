# Gate-Recall Guard — generalized keyword-gate regression harness

**Status:** Approved design — pending implementation plan. Effort folder: `.planning/2026-08-09-gate-recall-guard/`.
**Supersedes:** `qa/miss-rate-ab.ts` (dead since #5 revert — both tracked tools are `core:true`).
**Date:** 2026-08-09.

## Problem

`qa/miss-rate-ab.ts` is a standing regression guard that caught the #5 regression (81% adversarial miss-rate on `ask_user_question`/`todo` before revert). But it is hardwired to those two tools via a `TOOL_KEY` enum + two hardcoded probe arrays. After #5 was reverted (both tools → `core:true`), the guard is **dead**: it throws `probe references unknown gate '...'` because `CORPUS_GATES` only holds non-core gates, and those two tools no longer appear there.

Meanwhile the domain keyword-gates (`flux2`/`ltx`/`movie`/`krea2`/…) — the gates that **should** stay keyword-gated, per the recorded insight that keyword-gating suits crisp-intent domain tools — have **no recall coverage at all**. A future change that weakens their keywords would regress silently.

**Gap:** a reusable, owner-declared adversarial-recall guard over *all* non-core gates.

## Goal

A standing regression guard that, each run, measures every non-core keyword gate's recall against a realistic adversarial probe set, fails (non-zero exit) on regression, and runs as part of `bun run qa`.

## Non-goals

- Does NOT change gate *behavior* or the runtime `Gating` type.
- Does NOT replace the experimental telemetry-based `qa/miss-rate.ts` (kept as-is; flagged EXPERIMENTAL).
- Does NOT gate `core:true` tools — the #5 lesson: keyword-gating fails high-frequency workflow tools.

## Design

### 1. Data shape — owner-declared probe sets

Each gated extension exports a QA-only `__GATE_PROBES__` const from its entry file (NOT on the runtime `Gating` type):

```ts
export const __GATE_PROBES__ = {
  gate: "flux2",            // primary tool name; must match a name in CORPUS_GATES
  recallFloor: 0.9,         // default 0.9; 0 = controls-only (deliberate-dispatch gates)
  adversarial: string[],    // realistic "I need this tool" phrasings using NO current keyword
  controls: string[],       // contain a current keyword / satisfies requires-path — MUST fire
} satisfies GateProbeSet;
```

`GateProbeSet` type defined in tool-gate (exported); extensions use it via `satisfies`. See Open Questions for final home.

### 2. Discovery — static-export collector

New `qa/collect-probes.ts` statically imports every `__GATE_PROBES__` → `Map<string, GateProbeSet>`. tool-gate already statically depends on all gated extensions (it builds `CORPUS_GATES` by driving their registrars), so this adds **no new coupling class**. Adding a gate's probes = one import line.

### 3. Harness logic

New `qa/gate-recall.ts` (replaces `qa/miss-rate-ab.ts`). Iterate `CORPUS_GATES`; for each gate that has a probe set:

- `recall = adversarial-fired / adversarial-total` (via the existing pure `gateFires(gate, prompt)`).
- `controlsPass = every control fired`.
- verdict = `PASS` iff `recall ≥ recallFloor` **AND** `controlsPass`.

Rules:

- A **control that fails to fire is always FATAL** (the gate is broken), independent of `recallFloor`.
- A gate with **no probe set** → reported `UNCOVERED`; does NOT fail recall (cannot measure) but surfaced separately as a coverage gap (mirrors `qa/coverage.ts`).
- Overall exit: **non-zero if ANY gate FAILs or any control breaks.**

### 4. CLI & integration

- Script `qa:gate-recall` → `bun run qa/gate-recall.ts`. Keep `qa:miss-ab` as a back-compat alias to the new file.
- Wire as the **4th conjunct** into `qa/run.ts`: `bun run qa` = savings-floor ∧ L1-intended ∧ coverage ∧ **gate-recall**.
- Output: per-gate table (`gate | adversarial recall % | controls | floor | verdict`) + overall summary + `UNCOVERED` list.

### 5. Threshold calibration (de-risking)

Do NOT guess floors blind. Sequence:

1. Build harness + author starter probe sets per gate.
2. **RUN** → observe baseline recall per gate.
3. Set each `recallFloor` from observed reality + intent (crisp image/video gates high; deliberate-dispatch gates low/0).

This avoids locking in thresholds that either always-pass (useless) or always-fail (noise).

### 6. Probe-authoring guidance

- **flux2 / ltx** (noun∧verb `requires`): stress the requires path with no-noun phrasings ("render the scene as a picture") — recall hinges on noun∧verb.
- **movie** (keywords only): stress paraphrases ("orchestrate a montage from these scenes") — likely the highest miss; signal to add keywords or accept a lower floor.
- **dispatch gates** (`subagent`/`workflow`/`research`): author controls + a small adversarial set; set `recallFloor: 0` (controls-only) since narrow keywords are intentional.
- Each probe set includes **EN + zh** phrasings (gates are bilingual).

## Components touched

- `bun-apps/pi-agent-ext-tool-gate/qa/gate-recall.ts` — NEW; replaces miss-rate-ab.ts
- `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts` — NEW
- `bun-apps/pi-agent-ext-tool-gate/qa/evaluate.ts` — export helper if needed
- `bun-apps/pi-agent-ext-tool-gate/qa/run.ts` — add 4th conjunct
- `bun-apps/pi-agent-ext-tool-gate/package.json` — `qa:gate-recall` script; alias `qa:miss-ab`
- `bun-apps/pi-agent-ext-tool-gate/qa/miss-rate-ab.ts` — DELETE (replaced; if still present)
- One `__GATE_PROBES__` export added to each gated extension entry: `flux2`, `ltx`, `movie`, `krea2`, `file2md`, `workflow`, `subagent`, `research`, (+ any others present in `CORPUS_GATES` — enumerate in the plan)
- Tests: `qa/gate-recall.test.ts` (synthetic gates → deterministic PASS/FAIL/FATAL/UNCOVERED); a regression test asserting the guard fails on a deliberately-weakened keyword.

## Testing

- **Unit:** synthetic `GateProbeSet`s exercising PASS (recall ≥ floor, controls ok), FAIL (recall < floor), FATAL (control miss), UNCOVERED (no probes). Deterministic — no LLM, no telemetry.
- **Regression:** take a real gate, remove a keyword, assert the guard goes red.
- **Integration:** `bun run qa` includes gate-recall and is green on the calibrated baseline.

## Risks

- **Probe validity (main risk):** adversarial probes are subjective; poor probes → misleading recall. Mitigation: calibrate after the first run; bilingual; per-gate-type guidance.
- **Threshold churn:** floors set too high initially → noise. Mitigation: the calibration step.
- **Coverage debt:** a new gate added without `__GATE_PROBES__` → `UNCOVERED`. Mitigation: the UNCOVERED list; a future `qa:coverage`-style hard assertion once all gates are authored.

## Open questions (resolve in the plan)

1. Enumerate the exact current `CORPUS_GATES` members (confirm flux2/ltx/movie/krea2/file2md/workflow/subagent/research + any others) so the per-extension probe-export list is complete.
2. Final home of the `GateProbeSet` type — tool-gate (QA concern) vs `pi-tool-gating-contract` (shared). Lean: tool-gate.
3. Whether to co-locate `__GATE_PROBES__` in the extension entry file vs a sibling `gate-probes.ts` (cleaner separation for large sets) — both honor "owner-declared"; decide per-extension if a set is large.
