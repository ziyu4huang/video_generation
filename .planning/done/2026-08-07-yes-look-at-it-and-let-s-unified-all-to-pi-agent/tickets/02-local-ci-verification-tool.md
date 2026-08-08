---
type: task
status: closed
claimed: claude
---

# 02 — Local-CI verification tool

## Question

Automate AGENTS.md merge-workflow step 2 ("run local CI: `typecheck` + tests scoped to the changed package(s)") as a devops tool, so self-verification isn't ad-hoc bash — especially now that remote CI no longer gates anything.

## What to build

A devops tool (e.g. `local_ci` / `verify`) that detects changed packages vs `origin/main`, runs `typecheck` + `bun test` scoped to them (plus any repo-wide gates that matter), and returns a structured green/red result. Green = good to merge per the standing rule. Must work with remote CI disabled (no network dependency).

## Acceptance

- [x] Detects changed packages vs `origin/main`
- [x] Runs `typecheck` + `bun test` scoped to those packages
- [x] Returns structured pass/fail (which packages, which checks, exit codes)
- [x] No network dependency (remote CI disabled)

## Resolution

**Implemented on `feat/devops-local-ci-tool` — PR #1048 (OPEN, not merged per user workflow: "finish at PR, no ship").** Tool built; `tsc` clean; 110 tests pass (14 new in ci-recipe.test.ts). Acceptance met: detects changed packages (wraps `scripts/ci-changed-packages.sh`), runs typecheck (precedence rule) + `bun run test` scoped to them, returns structured `CiOutcome` (packages + gates + exitCodes), offline (no network). `local_ci` is the gate engine for ticket 04 (which calls it).
