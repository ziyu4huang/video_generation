# Ticket 05 — drop-run-sh-shim

status: closed
closed: 2026-08-23 — PR branch deploy/drop-run-sh-shim. Operator ended the
grace period the same day it started (ticket 02 shipped 10:44, operator asked
to remove the shim a few hours later): no external reference to the deploy's
`run.sh` exists on this machine.

## Problem

Ticket 02 kept `run.sh` in the deploy output as a one-line exec shim into
`s2-agent.sh` "for muscle memory". The operator reviewed the deployed tree,
asked why `run.sh` was still present, and decided the grace period is over —
every launcher reference (gates, e2e probes, verify-deploy-e2e, report) had
already moved to `s2-agent.sh` in ticket 03.

## Resolution (2026-08-23)

- `deploy/run.ts`: `RUN_SH` template + its staging write/chmod deleted;
  header comments reworded (the launcher doc names the drop).
- `tests/deploy-e2e.test.ts`: asserts `run.sh` does NOT exist in the staged
  tree (was: existsSync true).
- `tests/deploy-probe-e2e.test.ts`: the "executed, not merely present" probe
  and the sandbox-exec offline boot now run `s2-agent.sh` directly.
- Cosmetic references updated: `deploy-report.ts` launcher row,
  `verify-deploy-e2e-cli.ts` help, `deploy-e2e-recipe.ts` precondition
  comment.
- Repo-side `bun-apps/s2-agent/run.sh` (the DEV launcher the repo-root
  `s2-agent.sh` symlink points at) is untouched — only the deploy output
  changes. Old frozen version dirs on real outRoots keep their `run.sh`
  (immutable retention), and they still boot.

## Verification

- devops `bun run check` + `bun run test`; deploy e2e + probe e2e under
  `PI_AGENT_E2E=1`; live redeploy → post-deploy E2E, then `ls current/`
  shows no `run.sh`.
