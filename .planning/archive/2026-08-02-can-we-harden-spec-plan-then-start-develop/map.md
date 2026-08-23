> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-08-02-can-we-harden-spec-plan-then-start-develop

> **Status: SEALED (2026-08-02)** — destination + mechanism decided (D1–D3); zero open decisions. Handed to `writing-plans` (see [Handoff](#handoff-to-writing-plans)). The `memworth.fail` freeze itself is a separate follow-up, out of scope here.

## Destination

Harden the **spec→plan handoff** so a cross-file requirement cannot leak unimplemented.

Concretely: every spec requirement must map to a **verified** code location (`file:symbol`) that falls **inside some task's file-scope**, checked *before* development starts — closing the gap that left §3.6 (`memworth.fail` freeze) unimplemented in PR #1000.

## Notes

**The leak (PR #1000, evidence — don't re-dig):**
- Spec §3.6 "memworth.fail freeze": the spec's file-responsibility table mapped it → `src/store/memory-store.ts` (`spec.md:132`).
- Plan: the "Spec coverage" table self-attested "§3.6 memworth freeze → T5" (`plan.md:353`), and Task 5 was single-file scoped to `memory-store.ts` (`plan.md:230`).
- Reality: the sole `mwFail` increment is DB-side — `bumpMemoryWorth` at `worth-scoring.ts:82` — with **no presence inside `memory-store.ts`**. Task 5 couldn't implement it; the implementer correctly FLAGGED it rather than forcing a wrong change. No task touched `worth-scoring.ts`.

**Root cause:** spec→plan coverage is currently **self-attested** (the plan declares "All spec sections mapped"). Nothing verifies that each "§X → task Y" entry's *actual* code site lives inside task Y's file-scope. The spec's file-mapping was an assumption; the plan inherited it blindly.

**Repo pattern (precedent for the gate):** the repo already ships hard, CI-gateable drift guards — `skills-fidelity.test.ts`, `qa/savings-prose-lock.test.ts`, `test-portability-audit`. A spec-coverage check fits this family.

## Decisions so far

- **D1 — Specs must cite verified code sites.** Each requirement lists the *actual* `file:symbol` where the change lands (verified to exist in the tree), not an assumed file. The memworth gap would have been caught here: `memory-store.ts` contains no `mwFail` increment.
- **D2 — "Spec coverage" becomes a GATE, not a claim.** Every `§X → task Y` row must verify task Y's file-scope contains the requirement's verified code site. A requirement whose code site is in **no** task's scope is a **blocking error before dev** (the §3.6→T5 row would have failed this gate).
- **D3 — Automated script + CI gate, blocking.** Enforcement is a tool (not a skill-prompt soft check), CI-gateable, failing before development starts. Chosen because the leak was precisely soft self-attestation — a soft checklist would reproduce the same failure mode.

## Out of scope

- Retroactively rewriting the failure-lifecycle spec/plan.
- Implementing `memworth.fail` freeze-off-active itself — separate follow-up ticket (the FLAGGED item from PR #1000 Task 5; lives in `worth-scoring.ts`).
- Re-validating every past effort's coverage.

## Handoff to writing-plans

Build the automated spec-coverage gate. Implementation units:

1. **Spec format** — each requirement carries a structured `code_site: <path>:<symbol>` (e.g. a `## Requirements` block with per-item `code_site`, or a machine-readable coverage table). The cited `path` must exist in the tree; `<symbol>` should resolve (grep / TS symbol) — *open plan question*: exact field shape + how strict the symbol resolution is.
2. **Plan format** — each task carries `files: [<paths>]` declaring its file-scope. *Open plan question*: parse the existing `## Task N` plan headings, or require a structured frontmatter block per task.
3. **The check** (`scripts/check-spec-coverage` or a `bun test` in the existing matrix) — for every spec requirement: (a) its `code_site` path exists; (b) that path ∈ the union of all plan-task `files`. Emit the offending requirement on failure (e.g. "§3.6 code_site `worth-scoring.ts:bumpMemoryWorth` is in NO task's files").
4. **Enforcement wiring** — blocking: invoked at dev-start (SDD/self-review) + a CI job (alongside test-portability). *Open plan question*: apply to all `.planning/*/` efforts or opt-in (e.g. efforts with a coverage table only).

**Acceptance:** given a spec+plan where a requirement's verified code site is outside every task's file-scope, the gate fails with a precise message; given full coverage, it passes. The §3.6 case (reconstructed as a fixture) must fail.

**Suggested sequence:** formats (1+2) → check (3) → wiring (4). Pilot on the next real spec→plan before broad rollout.
