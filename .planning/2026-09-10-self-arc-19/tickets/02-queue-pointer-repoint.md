# t02 — Queue-pointer write-time validation: `repoint-next-goal.ts`

## Goal

The stale-byte-duplicate class dies at the write boundary. Repointing LATEST
becomes ONE command that cannot succeed while (a) the target is invalid,
(b) byte-duplicate goal files litter the queue, or (c) frontmatter dates
contradict filenames. The 2026-09-10 live find (one goal under two filenames,
LATEST naming the wrong one) becomes structurally impossible to leave behind.

## Files

- `bun-apps/s2-agent-ext-devops/src/repoint-next-goal.ts` (new) — pure logic,
  testable against temp dirs.
- `bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts` (new) — thin
  runnable entry (same shape as `scripts/validate-next-goal.ts`).
- `bun-apps/s2-agent-ext-devops/tests/repoint-next-goal.test.ts` (new).
- `bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` — +1
  allowlist line (`bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts`).
- `src/validate-next-goal.ts` — UNTOUCHED (validator stays pure; D4).

## Behavior

```
bun bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts <target> [--check]
```

1. **Validate target**: `validateNextGoalFile(target)` must pass (reuse
   `../src/validate-next-goal.js` as-is). Fail-fast with its check details.
2. **Dedupe**: scan `output/next-goal-*.md`; group by exact bytes. Within each
   byte-identical group keep the NEWEST filename (per
   `NEXT_GOAL_FILENAME_RE`), delete the rest, REPORT every deletion. If the
   requested target is itself a byte-duplicate of a newer filename, re-target
   to the newest and say so (the exact live case from 2026-09-10).
3. **Date honesty**: verify frontmatter `created:` equals the filename
   timestamp, and every `supersedes:` filename timestamp is strictly older
   than the target's own. Mismatch ⇒ fail with per-file detail.
4. **Repoint**: atomically update `output/LATEST-next-goal.md` (write tmp +
   rename). STEP 0 of implementation: read the CURRENT LATEST artifact to
   learn its form (symlink vs content file) and preserve that form — verify
   the artifact, then trust the label (learning #2).
5. **Doctor**: run `doctorNextGoal(outputDir)`; print one JSON result
   (validations + deletions + repoint + doctor); exit 0 ok / 1 failed / 2
   usage. `--check` = dry-run: report the plan, write nothing.

## Steps

1. Read `src/validate-next-goal.ts` fully (check names, result shapes) and the
   current LATEST form; write facts into the ticket resolution.
2. Implement src logic + tests with temp-dir fixtures: byte-dup pair (older
   deleted), target-is-stale-dup (re-target to newest), date mismatch
   (fails), clean queue (no deletions, repoint happens), `--check` mutates
   nothing.
3. Thin script + allowlist line; run devops package gates
   (`bun run --cwd bun-apps/s2-agent-ext-devops check && typecheck && test` —
   resolve the package's real script names from its package.json).
4. Dry-run against the REAL queue (`--check`); receipt the JSON to
   `evidence/t02-dry-run.json` (committed by t04).

## Acceptance

- Unit tests cover all five fixtures; devops gates green; scripts-dir
   contract green; `validate-next-goal.test.ts` untouched and green.
- Dry-run receipt on the real queue (no writes) committed under evidence/.
- t06 USES this tool for the arc's own close-out (the dogfood acceptance).

## Out of scope

- Changing the strict-v2 next-goal format itself.
- Committing anything under `output/`.
- Retention policy changes (MAX_RETENTION stays the doctor's business).
