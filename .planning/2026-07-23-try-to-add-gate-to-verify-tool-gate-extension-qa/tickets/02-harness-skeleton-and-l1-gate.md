## Question

Assemble the **harness skeleton + Layer-1 gate** — the single entrypoint that
makes the whole thing a *reusable gate* rather than scattered scripts.

**Deliverable:** one invocation in `pi-agent-ext-tool-gate` (e.g. `bun run qa`
or `bun test --cwd … qa/`) that:
1. runs the **savings** measurement (ticket 00) → prints baseline/gated/saved;
2. runs the **L1 probe corpus** (ticket 01) → per-gate fire/false-fire/escape-hatch
   pass-fail + a miss-rate summary;
3. emits a combined **report** (console + a written artifact) and an overall
   **pass/fail exit code** (CI-wireable);
4. leaves a clear **slot for Layer-2** (ticket 04) — a `--l2` flag or sub-command
   that runs the live A/B when invoked, absent by default so the default gate
   stays fast/deterministic.

**Decisions to resolve:** the pass/fail *thresholds* for the L1 numbers default
to "every must-fire fires, zero lookalike false-fires, every gate
escape-hatch-reachable" — strict, since these are deterministic. Loosening any of
them is a deliberate call recorded here (feeds ticket 05's verdict).

**type:** task
**blocked by:** [00 savings-measurement](00-savings-measurement.md), [01 l1-probe-corpus](01-l1-probe-corpus.md)
**claimed:** wayfind-session (2026-07-23) — ✅ CLOSED

## Resolution

Built the unified QA gate. New: `qa/evaluate.ts` (single evaluator — the one
source of truth for scoring the corpus), `qa/run.ts` (entrypoint). Refactored
`qa/probes.test.ts` to consume `evaluateCorpus()` (no duplicated scoring).
**158 tests still green**; `bun run qa` verified in default / `--strict` /
`--json` / `--l2` modes.

### `bun run qa` — what it does
savings (ticket 00) + L1 corpus (ticket 01) + an L2 slot, in one CI-wireable
invocation with an exit code. Emits a console summary **and** writes a markdown
report to `output/tool-gate-qa-report.md` (`--json` for machine output):
```
✅ PASS — intended-behavior bar holds; known issues reported (use --strict …)
savings:   5,554 tok/req (38.6%) — OFF 14,388 → ON 8,834  [vs ~8,500: -2,946]
L1:        must-fire 27/27 · must-not-fire 18/18 · escape-name 9/9 · escape-intent 9/9
known issues: 10 (6 false-fires, 4 blind gates)  [non-gating]
L2:        skipped (default; pass --l2 to run)
```

### Pass/fail model — the deliberate call (feeds ticket 05)
- **default = intended-behavior bar:** every MUST_FIRE fires, zero MUST_NOT_FIRE
  fires, every gate escape-reachable, + savings structurally sane. **GREEN today
  (exit 0).** The 10 known issues (6 precision false-fires + 4 blind intent-
  gates from ticket 01) are **reported, non-gating** — failing CI on pre-existing
  known issues is not actionable.
- **`--strict` = zero-known-issues bar:** additionally requires
  `knownIssueCount === 0`. **RED today (exit 1)** — the aspirational gate that
  turns green when tool-gate is fixed; doubles as a fix-detector.
- **`--l2` slot:** reserved; `runLayer2()` is a stub returning *not yet
  implemented (ticket 04)*. Default stays fast + deterministic.

### Verified
| mode | exit | verdict |
|---|---|---|
| default | 0 | ✅ PASS |
| `--strict` | 1 | ❌ FAIL — 10 known issues open |
| `--json` | 0 | clean machine output |
| `--l2` | 0 | stub no-op, slot wired |
| `bun test` | 0 | 158/158 pass |

### Implications handed forward
- **Ticket 04:** replace the `runLayer2()` stub with the live A/B; the `--l2`
  flag + report section are already wired to receive it.
- **Ticket 05:** the `--strict` exit code IS the aspirational verdict gate; the
  default report's known-issue registry + savings deviation ARE the verdict
  inputs (savings real-but-overstated; 10 capability gaps, 4 of them
task-breaking blind/mis-route).

**Assets:** `qa/evaluate.ts`, `qa/run.ts`, `qa/probes.test.ts` (refactored),
`package.json` (`qa` + `qa:savings` scripts), `output/tool-gate-qa-report.md`.
