# Plan — Migrate `docs/agents/` into `s2-agent-ext-devops` skills

Date: 2026-08-29
Spec: `.planning/specs/2026-08-29-migrate-docs-agents-to-devops-design.md`
Branch: `migrate-docs-agents-to-devops` (off `origin/main` @ 4ee6da0)

## Steps (single session, TDD-light: migration with one test-pinned string)

1. **Create six skills** under `bun-apps/s2-agent-ext-devops/skills/`:
   `domain-docs`, `extension-naming`, `issue-tracker`, `learnings`,
   `session-closeout-sop`, `shared-state-index`. Body = faithful copy of the
   `docs/agents/<file>.md` content with frontmatter added and intra-folder
   cross-refs repointed (domain ↔ shared-state-index; closeout →
   self-reflect-next-goal stays correct).
2. **Update the pinned string first** (test-lockstep): change
   `BOOT_HANG_DIAGNOSTIC` + doc comment in
   `bun-apps/s2-agent-ext-devops/src/oneshot-smoke.ts` and the matching
   `tests/oneshot-smoke.test.ts` assertion to the new learnings path; run
   `bun test tests/oneshot-smoke.test.ts` inside the package → green.
3. **Sweep references** (exact list in the spec §Reference sweep): CLAUDE.md,
   front-door gate table, ultracode comments, wayfind triage, research-tool
   CONTEXT, superpowers pi-tools, adr-citation comment.
4. **Delete** `docs/agents/` (`git rm`).
5. **Verify** (spec §Verification): discovery list, package gates,
   `run_local_ci`, final grep.
6. **Ship** via devops chain: commit (spec+plan first commit, migration
   second), push, PR, `merge-pr-after-ci-cli.ts <pr> --expected-scope …`,
   `verify-merge-cli.ts <pr> --scope …`.
7. **Close out**: strict-v2 successor next-goal (focus: s2-agent-ext-*
   hardening), validator, repoint LATEST.

## Expected touched roots (verify-merge scope)

- `docs/agents/` (deletions)
- `bun-apps/s2-agent-ext-devops/` (skills + src + tests)
- `bun-apps/s2-agent-ext-ultracode/` (comments)
- `bun-apps/s2-agent-ext-wayfind/` (triage skill)
- `bun-apps/s2-agent-ext-research-tool/` (CONTEXT.md)
- `bun-apps/s2-agent-ext-superpowers/` (pi-tools.md)
- `bun-apps/tests/` (adr-citation comment)
- `CLAUDE.md`
- `.claude/skills/`
- `.planning/`
