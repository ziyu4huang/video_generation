---
effort: 2026-08-11-superpowers-bootstrap-trim
title: Trim the superpowers bootstrap payload (scope A+B+C)
status: "Approved (scope A+B+C)"
date: 2026-08-11
approach: Compress the two ext-generated halves of the superpowers bootstrap
  (`piToolMapping` + `piBoundaryOverrides`) via three independent, test-pinned
  edits; leave the FIDELITY-LOCKED `using-superpowers` body byte-untouched.
---

# Spec — Superpowers bootstrap payload trim (scope A+B+C)

## Background

The superpowers bootstrap (`bun-apps/pi-agent-ext-superpowers/src/superpowers.ts`
`getBootstrapContent()`) is injected eagerly into context on every `session_start`
and every `session_compaction` until the first `agent_end`. Until that point it is
the dominant per-session eager cost (~2,039 tok), larger than the whole 12-skill
advertised set combined (~1,181 tok), per the corrected ADR-0008 cost model
(#1239). The cost compounds across every compaction.

Composition (approximate):

- intro (~70 tok) — marker + "You have superpowers." frame
- `using-superpowers` body (~716 tok) — **FIDELITY-LOCKED** by ADR-0004 (byte-equal
  to its committed baseline fixture; `skills-fidelity.test.ts` guards it)
- `piToolMapping()` (~765 tok) — ext-generated, editable
- `piBoundaryOverrides()` (~494 tok) — ext-generated, editable

Roughly half the payload (the two ext-generated functions, ~1,259 tok) is NOT
fidelity-locked and is the trim surface. The locked body is untouched by this
effort.

## Goal

Trim the two ext-generated halves by ~690 tok (~34% of the whole bootstrap,
~55% of the non-locked half) with **NO behavior change** and **NO dropped
test-pinned literal**. The locked `using-superpowers` body stays byte-identical.

## Design

Three independent, composable trims. Each is gated by an existing or added
literal assertion so a regression cannot pass silently.

- **D1 (Scenario B, ~131 tok):** delete the `piToolMapping` paragraph that
  restates Pi's own injected built-in tool list (`read`/`write`/`edit`/`bash`/
  `grep`/`find`/`ls`) — it is pure restatement of the tools Pi already injects
  into context — and delete the task-list mapping paragraph, which duplicates the
  detailed guidance already in `references/pi-tools.md` (`## Task lists`).
  Keeps the header, the native-skill paragraph, and (for now) the subagent
  paragraph.
- **D2 (Scenario A, ~402 tok, MED risk):** compress the ~2,230 B subagent
  overlay to a single ~620 B param-list line that (a) preserves every test-pinned
  literal, (b) names `watchdog:{l2:true}` as the advisory adversarial-review
  guardrail, and (c) mandates `read references/pi-tools.md FIRST` before any SDD
  implementer/fix dispatch. The dropped rationale (tier resolution source,
  `commitScope` git-add-A sweep story, auto-parse/auto-persist mechanics, L1/L2
  watchdog internals) moves to on-demand consumption of `references/pi-tools.md`.
  Mitigation: the locked body's `EXTREMELY-IMPORTANT` read mandate + the explicit
  "read FIRST" instruction + the advisory-only failure mode keep the behavior
  contract intact.
- **D3 (Scenario C, ~157 tok):** tersify the `piBoundaryOverrides` prose — rule 1
  connective clauses, the stage table's markdown padding, and the closing
  "Four of five stages are a filesystem check" line — while keeping every path
  literal, the full 5-row stage table, and the `grilling`/`to-spec`/`brainstorming`
  verbatim. Must stay within the `800 < len(routing) < 2000` band pinned by
  `bootstrap.test.ts`.

## Testing

The existing test suite is the regression guard; one assertion is added.

- `bootstrap.test.ts` — all 8 `piToolMapping` literal assertions
  (`subagent`, `task`, `/tier|tools|excludeTools|cwd|model/`, `tier`,
  `capability?`, `commitScope`, `tokenBudget`, `spendBudget`,
  `references/pi-tools.md`, `parallel()`) and all 15+ routing literals
  (`## Pipeline routing (this repo)`, `One canonical home`, every `.planning/...`
  path, `PI_PLANNING_EFFORT`, `sdd-workspace PLAN_FILE`, `.planning/specs/`,
  `symlink`, the 5 stage names, `to-spec`, `brainstorming`, `check what's on disk`)
  stay green; the `800 < len < 2000` band stays satisfied. **ADD** a
  `expect(piToolMapping()).toContain("watchdog")` assertion to pin the advisory
  guardrail literal that mitigates D2's MED risk.
- `routing-contract.test.ts` (cross-ext, `bun-apps/tests/`) — asserts
  `grilling` + `to-spec` still appear in `src/superpowers.ts` source and still
  exist in `pi-agent-ext-wayfind/skills/`. Stays green.
- `skills-fidelity.test.ts` — asserts `using-superpowers/SKILL.md` is
  byte-equal to its fixture. Stays green (proves the locked body was not touched).
- `bun run build` (`bunx tsc`) green; full `pi-agent-ext-superpowers` suite green.
- Measure bootstrap before → after (target ~-690 tok / ~-2,762 B combined).

## Risks

- **D2 — MED.** Moving rationale to on-demand read of `references/pi-tools.md`
  relies on the agent following the read mandate. Accepted per the chosen scope;
  mitigated by the locked body's `EXTREMELY-IMPORTANT` read mandate, the explicit
  "read FIRST" instruction, and the advisory-only failure mode (worst case: the
  agent omits `watchdog`, which is advisory and never blocks).
- All edits preserve every test-pinned literal verbatim → the test suite is the
  regression guard; a dropped literal fails the build, not silently misroutes.

## Non-goals

- Touching the locked `using-superpowers` body. (The `## Red Flags` table
  ~150 tok is the next gated target if ADR-0004 is later amended — explicitly out
  of scope here.)
- Changing the bootstrap injection mechanics (eager injection until first
  `agent_end`, compaction re-arm, marker-based dedup).
- Editing `references/pi-tools.md` itself (it is the on-demand rationale sink and
  is unchanged here).
