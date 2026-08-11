---
effort: 2026-08-11-superpowers-bootstrap-trim
status: active
---

# Plan — Superpowers bootstrap payload trim (scope A+B+C)

TDD task list. Each task: apply, build, run the scoped test, confirm green +
byte delta. Leave the tree dirty for reviewer audit (no commit).

## Task 1 — D1 (Scenario B): delete the restated tool list + task-list mapping

- In `piToolMapping()`:
  - DELETE the paragraph beginning
    "Pi's built-in coding tools are lowercase: `read`, `write`, `edit`,
    `bash`…" (restates Pi's own injected tools).
  - DELETE the paragraph beginning
    "Pi does not ship a standard task-list tool…" (duplicates
    `references/pi-tools.md` `## Task lists`).
  - KEEP the `## Pi tool mapping` header, the native-skill paragraph
    ("Pi has native skills but does not expose Claude Code's `Skill` tool…"),
    and the subagent paragraph (T3 — for now).
- CONFIRM the token `task` still appears (it is in the T3 subagent signature
  `subagent({ task, … })`), so `bootstrap.test`'s `toContain("task")` still
  passes.
- Gate: `bun run build` green; `bun test` green (bootstrap + routing band still
  hold with T3 unchanged).
- Expected: ~-526 B on the tool section.

## Task 2 — D2 (Scenario A): compress the subagent overlay

- In `piToolMapping()`: REPLACE the entire T3 subagent paragraph (the one
  beginning "Pi does not ship a standard subagent tool in core…") with the
  single compressed line that:
  - preserves every test-pinned literal (`subagent`, `task`, `tier`,
    `capability?`, `commitScope`, `tokenBudget`, `spendBudget`,
    `references/pi-tools.md`, `parallel()`, and every token of
    `/tier|tools|excludeTools|cwd|model/`),
  - names `watchdog:{l2:true}` as the advisory adversarial-review guardrail,
  - mandates `read references/pi-tools.md FIRST` before any SDD
    implementer/fix dispatch.
- ADD to `bootstrap.test.ts` (piToolMapping assertions block):
  `expect(piToolMapping()).toContain("watchdog");`
- Gate: `bun run build` green; `bun test` green INCLUDING the new `watchdog`
  assertion.
- Expected: ~-1,610 B on the tool section.

## Task 3 — D3 (Scenario C): tersify `piBoundaryOverrides` prose

- Compress the explanatory prose in `piBoundaryOverrides()`:
  - Rule 1 ("**1. One canonical home.**"): keep ALL path literals verbatim;
    shorten the connective "Specs → `.planning/specs/…` symlink there — prefer
    the `.planning/` path. Other upstream paths… never written… falls back to
    flat…" clause.
  - Rule 2 stage table: keep all 5 rows + stage names + `grilling`/`to-spec`/
    `brainstorming` verbatim; trim markdown padding only.
  - Closing line: tighten "Four of five stages are a filesystem check…" if it can
    lose ~30 B without losing meaning.
- HARD CONSTRAINT: after edits, the routing section (from
  `## Pipeline routing (this repo)` to end) MUST satisfy
  `800 < length < 2000` (`bootstrap.test`). Measure and confirm margin.
- Gate: `bun run build` green; `bun test` green (routing band + literals hold).
- Expected: ~-626 B on the routing section.

## Final verification

- Full `pi-agent-ext-superpowers` suite green.
- Cross-ext `bun-apps/tests/routing-contract.test.ts` green (`grilling`/`to-spec`
  preserved in source + ext skills).
- `bun-apps/pi-agent-ext-superpowers/tests/skills-fidelity.test.ts` green
  (locked `using-superpowers` body byte-unchanged).
- `bun run build` green.
- Measure total before → after; target ~-2,762 B combined (~-690 tok).
- Comment ↔ emitted ↔ test consistency check across
  `superpowers.ts` / `bootstrap.test.ts` / `routing-contract.test.ts`.

## Actuals (post-implementation, reviewer-verified)
Full bootstrap 8199 → 5675 B (−2524 B, ~−630 tok; ~91% of the ~−690 target — D2/D3 applied conservatively). Route section 1998 → 1450 B (band 800–2000). Locked using-superpowers body byte-untouched (skills-fidelity green). Every bootstrap.test + routing-contract literal preserved; added a `watchdog` assertion (D2 advisory-guardrail pin).
