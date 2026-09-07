# Ticket 02 — Suite B: ultracode CC-parity workflow samples

Status: open · Phase 1 · Package: `bun-apps/s2-agent-ext-ultracode`

## Goal

Four REAL workflow scripts shaped like the workflows-doc example prompts
(code.claude.com/docs/en/workflows), committed under `samples/cc-parity/` and
executed in tests by the real WorkflowManager with the injected `fakeAgent`
runner — no LLM in unit gates.

## Context

- Precedent: `tests/workflow-manager.test.ts:13` defines `fakeAgent(usage, result)`
  and constructs `new WorkflowManager({ cwd, agent: fakeAgent(...) })` — real
  runtime, fake agent. `samples/` already holds real scripts
  (`kcard-converge-loop.js` etc.) with the `samples/run.ts` headless runner.
- Runtime constraints (from kcard header comment): no `process`/`Date`/`import`
  inside workflow scripts; helpers inlined; paths resolve via agents/args.
- Verify-then-pin the script-loading seam (path load vs read+eval) — fog-of-war
  item in map.md; whichever the runtime supports is what the tests use.

## Work (four scripts + one test file `tests/cc-parity-workflows.test.ts`)

- **B1 audit-many-files.js** (pattern: "Audit many files for the same issue"):
  `args.filenames` fans out one `agent()` per seeded file via `parallel()`;
  each returns `CLEAN` or `ISSUE: <line>`; a `pipeline()` collect+verify step
  filters issues; `phase()` + `log()` frame the summary. fakeAgent keys
  deterministic per-file results off prompt content; assert collected issues are
  exactly the planted set.
- **B2 verify-fix-loop.js** (pattern: "Keep fixing until a check passes"):
  bounded loop (maxAttempts 3) of fixer `agent()` → checker `agent()`.
  fakeAgent is STATEFUL (closure flipping to PASS after N fixer calls) — two
  assertions: (a) loop exits early on PASS, (b) a never-PASS variant stops at
  maxAttempts with the bounded-failure surface intact.
- **B4 review-per-file.js** (pattern: "Review every changed file, one summary"):
  `parallel()` reviewer per file, then ONE synthesizer `agent()` consuming all
  outputs; assert the synthesizer's prompt contains every per-file finding
  (positional completeness) and the run's final result is the synthesis.
- **B5 research-fanout.js** (pattern: "Research a topic across many sources"):
  3 reader `agent()`s over seeded source docs + synthesizer; one reader is made
  to STOP — assert the doc's null-for-stopped filtering drops it and the
  synthesizer still runs on the survivors; `meta` block present.

## Descoped (map D6 — record in catalog, do not build)

- B3 migrate-in-parallel: requires WRITABLE fan-out children; batch children are
  read-only by design (parity deviation, not parity).
- B6 find-issues-until-convergence: already receipted by
  `samples/kcard-converge-loop.js` (loopUntilDry); catalog maps B6 → that sample.

## Gates

`( cd bun-apps/s2-agent-ext-ultracode && bun run check && bun run typecheck && bun test )`.
Schema-cost +0 (sample scripts are runtime data, not extension entries).

## Done when

Four scripts committed, four test groups green, each test named after its CC
use case; fixtures (seed files) committed alongside or under `tests/fixtures/`.
