# Spec: Simplify extension tool/skill prompt weight (superpowers + wayfind)

Effort: `2026-07-25-simplify-ext-prompt-weight` · Status: DRAFT · Owner: agent + user

## 1. Problem

The agent's per-request **API tools schema costs ~12,370 tok and repeats every
request** (measured via `inspect_context`). Within the superpowers + wayfind
surface specifically, the `subagent` tool alone is **1,004 tok** (a 3,760-char
parameter schema) — the single biggest tool in the whole agent.

The always-on **skill descriptions are already light** (~2,927 tok for all 31
skills; full bodies load on-demand via `read`). But several skill *bodies*
teach concepts modern LLMs already perform well (TDD, systematic debugging,
brainstorming, verification discipline), and the `subagent` tool's parameter
schema is far more verbose than it needs to be for correct usage.

**Goal:** cut the repeat-every-request tool tax and unload redundant skills,
**without degrading behavior** — verified empirically, not assumed.

## 2. Constraints

- **ADR-0004 (fidelity pin).** The 14 superpowers `SKILL.md` are byte-identical
  pinned (whole files, incl. frontmatter descriptions). NOT editable. A pinned
  file MAY stay on disk while we *unregister* it from the manifest (fidelity
  intact, just not loaded) — but only if probes prove no behavioral regression.
- **Editable surface:** tool schemas (`pi-agent-ext-subagent`), wayfind skill
  bodies + descriptions (no upstream pin), pi-port glue (`references/*.md`,
  bootstrap `piBoundaryOverrides()`).
- **ADR-0005.** wayfind + superpowers remain parallel, coexisting packages. No
  merge.

## 3. Approach — tiered, tool-first, prove-the-loop

Phase 1 → 2 → 3, each de-risking the next. The probe harness is built in Phase 1
on the safest, highest-value target, so the empirical loop is *proven* before
any risky skill-removal decision.

## 4. The probe harness (shared verification infrastructure)

**Probe = a committed fixture:**

```
probe {
  id, phase,
  prompt,         // the scenario to run
  rubric,         // behavioral checklist (what "good" looks like)
  structural,     // machine checks (tool called? skill fired? test-first?)
}
```

**Runner** = a `workflow` script (`probe-runner.<phase>.ts`, committed under a
`scripts/` location pinned in the plan) that, for each probe, dispatches an
isolated `subagent` with the prompt, captures its transcript, then a **judge
subagent** grades it 0–3 per rubric item + runs the structural checks. Output:
a per-probe score table + delta vs baseline.

**Two modes (key decision):**

| Mode | Phase(s) | How the comparison side is obtained |
|---|---|---|
| **Baseline-regression** | 1 (tools), 2 (wayfind bodies) | Record the *fat* output once → `.planning/<effort>/probes/baseline.json`. After editing, run thinned, diff vs baseline. No config swap (the artifact exists in both; we check the edit didn't degrade usage). |
| **True A/B swap** | 3 (skill removal) | Run each probe under `manifest.fat.json` AND `manifest.thin.json` (the thin manifest omits the candidate skill from registration). Live diff. Only phase needing a real config swap. |

**Pass criterion:** thinned score ≥ baseline − 1 per rubric item (tolerance)
**AND** zero structural regressions. Any probe failing → revert that single
change, keep the rest.

**Scoring = LLM-as-judge (rubric-anchored) + structural assertions.** Pure regex
cannot see "did it resist rationalization," so the judge carries the behavioral
signal; structural checks catch the objective stuff (tool invoked with valid
args, test written before impl).

**Why workflow + subagents:** isolated context per probe (no cross-contamination),
deterministic orchestration, harness already exists (`workflow` / `subagent`
tools) — no new infra, just a script + fixtures.

## 5. Phase 1 — tool schema slimming (guaranteed floor)

Target the biggest single tool. Slim `subagent` (1,004 → ~450 tok) and
`subagent_runs` (249 tok). Preserve every parameter's *semantics*; cut only
verbosity (terse descriptions, fold redundant phrasing, move long examples out
of the schema into a help side-channel if needed).

- **Probes:** "dispatch a subagent for X" / "recall a past subagent run"
  scenarios across read-only, implementer, and reviewer roles.
- **Structural check:** the tool is invoked with a schema-valid argument set.
- **Mode:** baseline-regression (record fat, diff thinned).
- **Guaranteed win:** ~550 tok/req saved, independent of later phases.

## 6. Phase 2 — wayfind bodies + descriptions

wayfind skills are editable (no pin). Thin verbose on-demand *bodies* and
tighten the ~860 tok of always-on *descriptions* (domain-modeling, grilling,
grill-memory; command skills are already 0 tok always-on).

- **Probes:** grill a simple decision · model a tiny domain · fire the wayfind
  entry path.
- **Structural check:** expected artifacts produced (CONTEXT.md / glossary /
  ADR stub), entry-path routing honored.
- **Mode:** baseline-regression.

## 7. Phase 3 — "LLM already knows" skill-unload audit

Candidates (well-known-concept superpowers skills): `test-driven-development`,
`systematic-debugging`, `brainstorming`, `verification-before-completion`.

For each: run probes under `manifest.fat.json` vs `manifest.thin.json` (thin =
candidate unregistered). The pinned file stays on disk (ADR-0004 intact);
**unregister only if every probe shows zero regression**. If any regresses,
keep the skill loaded.

- **Probes:** "implement feature X" (TDD) · "fix this bug" (debugging) ·
  "let's build Y" (brainstorming) · a claim-completion trap (verification).
- **Structural + judge:** test-before-impl · debug-hypothesis-before-fix ·
  design-before-code · evidence-before-success-claim.
- **Mode:** true A/B swap.

## 8. Success criteria

1. ~550 tok/req saved from Phase 1 (guaranteed floor), more if Phases 2–3 land.
2. Every change kept only after its probe suite passes (thinned ≥ baseline − 1,
   zero structural regressions).
3. Structural gates stay green throughout: `skills-fidelity` (ADR-0004),
   `extension-contract`, package `bun test` suites.
4. Probe harness + fixtures committed and re-runnable for future edits.

## 9. Out of scope

- Editing the 14 pinned superpowers `SKILL.md` bodies (would require revisiting
  ADR-0004 — explicitly NOT chosen in this effort).
- wayfind ↔ superpowers merge (ADR-0005).
- Rearchitecting the skill system to lazy/on-demand loading (separate effort).
- Non-superpowers/wayfind tools (knowledge-card, workflow, etc.) — out unless a
  later effort broadens scope.
