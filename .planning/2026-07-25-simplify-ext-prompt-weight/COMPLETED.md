# Status: COMPLETE (2026-07-26)

All 6 tasks done. The simplify-ext-prompt-weight workstream realized **~377 tok/req**
(Phase 1 tool-schema slimming for `subagent`/`subagent_runs` + Phase 2 wayfind/hermes-memory
skill-description thinning), with **~139 tok/req more opt-in** via
`PI_SUPERPOWERS_SKILL_EXCLUDE=verification-before-completion`.

## Phase 3 A/B verdicts (empirical, not assumed)
- **test-driven-development** — load-bearing (test-first behavior 3→0 when unloaded). KEEP.
- **systematic-debugging** — inconclusive (load noise). KEEP.
- **brainstorming** — behaviorally redundant but blocked by a strict structural gate. KEEP.
- **verification-before-completion** — clean pass on both probes. Safe to unload (~139 tok).

## Key artifacts
- Per-task ledger: `sdd/progress.md` (transient — gitignored).
- Task detail: `sdd/task-{1,2,4,5,6}-report.md`.
- Review packages: `sdd/review-*.diff`.
- Probes: `probes/phase{1,2,3}-*.{ts,md,json,log}`.

Commit trail: `1a2a0cb3` → `e52b2b5b` (see `git log --oneline -- .planning/2026-07-25-simplify-ext-prompt-weight/`).
