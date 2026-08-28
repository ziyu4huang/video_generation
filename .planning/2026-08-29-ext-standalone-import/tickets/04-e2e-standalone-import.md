---
type: task
blocking: 02
status: open
---

# 04 — E2E probe `standalone-import`

## Question

Does the deployed shim actually work the way an external consumer uses it —
from a scratch dir with no repo, no workspace, no network?

## What to build

A new `standalone-import` probe in the deploy-e2e recipe (runs with the
automatic post-deploy E2E; `verify-deploy-e2e-cli` picks it up for post-hoc
runs). Steps: (1) write a ~10-line consumer script into an empty temp dir
OUTSIDE the repo and dist trees; (2) the script requires the deployed
`<versionDir>/ext/ext-standalone.cjs`, calls `listExts()`, `loadExt("devops")`,
and executes `sync_default_branch` in dry-run against a throwaway fixture
git repo created by the probe (git-only, offline); (3) assert a structured
JSON outcome (`commands[]`, ok/aborted shape); (4) cross-check `file2md`
through the shim with the existing OCR fixture (proves `#pi/ext-dir` +
deployed assets pass through); (5) scan the shim for build-machine absolute
paths (Gate 4's scanner, applied at probe time). Verdicts follow the probe
family's pass/fail/skip semantics; bounded wall-clock budget like siblings.

## Acceptance

- [ ] Probe passes on a fresh deploy end-to-end: scratch-dir consumer
      executes the devops dry-run tool and returns structured JSON
- [ ] file2md cross-check through the shim returns the OCR fixture result
- [ ] Foreign-path scan of the shim is clean at probe time
- [ ] A deliberately broken shim (fixture) fails the probe — proof the
      probe detects, not just executes
- [ ] Probe report joins `deploy-report.yaml` / deploy-e2e JSON with
      timings; canonical devops package gates green
