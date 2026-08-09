---
type: task
blocking: []
status: closed
---

## Question
`discoverActivePlan` (`bun-apps/pi-agent-ext-core-task/src/plan/coordinator.ts` ~`:78-86`) picks the newest `.planning/<effort>/map.md` as the active effort, but if that effort has no `plans/` dir it **falls back to `docs/superpowers/plans/`** and grabs an **unrelated stale plan** → `goal_complete` false-positive (failure memory #278). The fallback is not guarded against cross-effort contamination.

## What to build
- Guard the fallback: if the active effort has no `plans/` dir, do **not** fall back to a different effort's plans — surface "no active plan" instead.
- Add a test: an effort with a map.md but no `plans/` must NOT pick up an unrelated plan from `docs/superpowers/plans/` (or another effort).

## Acceptance
- The fallback never crosses effort boundaries; `goal_complete` no longer false-positives on a plan-less effort.
- Test proves an unrelated plan is rejected; `bun test` + `bun run typecheck` green in `pi-agent-ext-core-task`.

## Resolution
Fixed in `6b9ad2c2`: `discoverActivePlan` returns "no active plan" instead of falling back across effort boundaries when the active effort's `plans/` dir is empty/absent; test asserts an unrelated plan from another effort/docs is rejected.
