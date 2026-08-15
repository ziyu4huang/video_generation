## Question

Execute the ADR-0004 re-pin: copy upstream's current SDD files into the fork's pinned set, add the new `re-review-prompt.md`, and update ADR-0004's pin record (hash/manifest) + `skills-fidelity.test.ts` so the pin tracks upstream-current.

**type:** task (AFK)
**claimed:** agent-session (2026-07-26) — **CLOSED**
**blocked by:** —  *(UNBLOCKED 2026-07-26: origin/main's 13 commits touch zero SDD files; the rebase is not needed for this re-pin. The subagent-ext conflict is a separate workstream — see ticket 01.)*

## Acceptance

- `skills/subagent-driven-development/SKILL.md` ← upstream current (503 lines).
- `implementer-prompt.md` (+3), `task-reviewer-prompt.md` (−3) ← upstream current.
- `re-review-prompt.md` **ADDED** (new file).
- ADR-0004 pin record + `skills-fidelity.test.ts` updated to assert upstream-current (re-record the fidelity baseline).
- **Do NOT** edit the pinned files' paths — the re-pinned `SKILL.md` references upstream's `.superpowers/sdd/<plan-slug>/`; the pi-port glue (ticket 06) overrides those at runtime to the effort×plan layout. The pin is verbatim; the override is runtime.
- `skills-fidelity.test.ts` + full superpowers suite green after re-pin.

## Resolution (2026-07-26)

**DONE — commit `09dbb7c4`.** All acceptance criteria met:

- `SKILL.md` 418 → 503 (== upstream v6.2.0 `3dcbd5c4`); `implementer-prompt.md` 139→142, `task-reviewer-prompt.md` 188→185; `re-review-prompt.md` **added** (106 lines).
- Fixture rebaselined via `scripts/rebaseline-upstream-skills.ts` — only `subagent-driven-development.md` changed (313 ins / 228 del — the lifecycle reorg moved blocks, not just net +85).
- `UPSTREAM.ref` provenance updated (v6.2.0, `3dcbd5c4`, 2026-07-23) + re-sync log.
- pi-convention leak check: **clean** (no `.planning/`, `goal_complete`, `ADR-`, `task_plan.md`, `pi-agent` — pure upstream).
- Full suite: **122 / 0** (fidelity 15/15, bootstrap routing 4→2 intact, skill-exclude all pass).

**Feeds ticket 06:** the re-pinned `SKILL.md` now references upstream's `.superpowers/sdd/<plan-slug>/` paths — pi-port glue must override those at runtime to `.planning/<effort>/sdd/<plan-slug>/` (per ticket 03's Nest decision). The fix-loop needs no harness work (pi uses the fresh-dispatch fallback — ticket 04).

**status:** closed
