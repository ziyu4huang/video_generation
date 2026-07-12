## Description

<!-- What does this PR change, and why? Link to the related issue below. -->

Closes #ISSUE_NUMBER    <!-- Replace with actual issue number; remove if no issue. -->

## Type of change

- [ ] Bug fix (issue: #N)
- [ ] New feature (issue: #N)
- [ ] Refactor / tech debt
- [ ] Documentation / CI
- [ ] Other (describe below)

## Pre-review checklist

- [ ] `bun test` passes in all affected packages (or `CI=true bun test` for CI-safe subset)
- [ ] New / changed behavior has tests
- [ ] Documentation updated (README, `CLAUDE.md`, or inline docstrings)
- [ ] Schema updated and `bun run check:schema` passes (if applicable)
- [ ] `scripts/ci-file-size-guard.sh` passes (no files > 2 MB)

## Manual test evidence

<!-- Briefly describe what you tested manually. For generation features, include a sample output or screenshot if practical. -->

---

<!-- PR discipline:

     - One PR → one issue (1:1). If solving multiple issues, split into separate PRs.
     - For large changes from a tracking issue: each sub-issue gets its own PR.
       The last PR in the chain writes `Closes #tracking-issue`.
       Earlier PRs write `Ref #tracking-issue` (so the issue stays open).
     - No issue → no PR (exceptions: trivial typo, doc fix, CI-only change). -->
