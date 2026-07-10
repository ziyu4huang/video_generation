# Task Plan — Distill fast-model configuration (settings floor)

## Goal

Make distill (`zk_extract` / `zk_card` / `zk_ask` / `obsidian_distill` /
`obsidian_garden`) reliably fast by giving the obsidian subagent a persistent
**floor model** (`deepseek-v4-flash`) via `settings.json`, injected as
`OB_SUBAGENT_MODEL` at startup.

## CRITICAL ARCHITECTURE FINDING (mid-task)

Investigation revealed the deployed `pi` is `pi-agent/src/cli.ts` → pi-coding-agent
`main()` (a thin patched wrapper), NOT `pi-agent-cli`. The real pi TUI **does not**
publish `OB_PARENT_MODEL`/`OB_SUBAGENT_MODEL` at all — that was the TRUE root cause
of the "no subagent model configured" warning + slow distill. So the fix needs TWO
injection points (both done):

1. **`pi-agent-cli`** (`bun-pi-agent-cli`, secondary CLI) → `shared.ts` `createSharedSession`.
2. **Deployed `pi`** → new `subagent-model-floor` patch in `pi-agent/src/patches/`.

User decision: implement in `__ext` (proper git flow); keep the pi-agent-cli change.

## Phases

### Phase 1 — Implement floor injection (TWO points) ✅
- [x] `pi-agent-cli/src/sessions/shared.ts`: `applyObsidianSubagentFloor()` +
      `readUserSettings()`, called in `createSharedSession` before `OB_PARENT_MODEL`.
- [x] `pi-agent/src/patches/subagent-model-floor.ts`: pure `resolveSubagentFloor()` +
      import-time side effect (reads `obsidian.subagentModel` → `OB_SUBAGENT_MODEL`).
- [x] Register patch in `pi-agent/src/patches/index.ts` (PatchName + PATCH_TABLE +
      switch; placed after `ensure-extension-deps` for the getAgentDir import).
- [x] 6 unit tests (shared.test.ts) + 11 unit tests (subagent-model-floor.test.ts).
- [x] index.test.ts "covers all known patches" updated.
- **Status:** complete

### Phase 2 — Set floor in settings.json ✅
- [x] Added `"obsidian": { "subagentModel": "deepseek/deepseek-v4-flash" }` to
      `~/.pi/agent/settings.json` (valid JSON, verified).
- **Status:** complete

### Phase 3 — Validate model + floor ✅
- [x] Model id verified: `deepseek/deepseek-v4-flash` matches `model-tiers.json`;
      `DEEPSEEK_API_KEY` set; deepseek is a built-in provider.
- [x] Distilled power-tool PRD via `zk_extract --model deepseek-v4-flash` → **5 cards,
      12 cross-links, MOC-indexed, NO timeout** (empirical speed proof).
- [x] Floor auto-activation: unit-tested + `applyPatches` integration test imports
      the real module (import-safe). Runtime activation of the patch is deferred to
      post-deploy (__pi) per the user's __ext-flow choice.
- **Status:** complete

### Phase 4 — Document + unblock PRD distill ✅
- [x] Documented `obsidian.subagentModel` + `OB_SUBAGENT_MODEL` precedence +
      `BUN_PI_SUBAGENT_MODEL_FLOOR` gate in `pi-cross-machine-setup.md`.
- [x] Update `.planning/prd-distill/`: unblock (power-tool now also distilled).
- **Status:** complete

### Phase 5 — Infra validation ✅
- [x] `bun test` pi-agent-cli: shared.test.ts 18/18 pass (full suite: 4 pre-existing
      missing-module fails unrelated to change, confirmed via stash).
- [x] `bun test` pi-agent: 184 pass / 0 fail (54 e2e-skip), zero regressions.
- **Status:** complete

## Validation Checklist

- [x] `settings.json` accepts `obsidian.subagentModel` (valid JSON)
- [x] `deepseek-v4-flash` distill completes with no timeout (power-tool: 5 cards)
- [x] per-call `--model` still overrides (power-tool run used it)
- [x] env precedence: `export OB_SUBAGENT_MODEL` wins (unit-tested in both files)
- [x] `pi-cross-machine-setup.md` documents all config paths
- [x] `bun test` passes in pi-agent + pi-agent-cli (shared.test.ts)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Approach A (settings floor) | user-confirmed; minimal, correct channel for flash |
| Model = deepseek-v4-flash | user-confirmed; fast, proven via power-tool distill |
| Field = `obsidian.subagentModel` | obsidian-scoped; avoids polluting ext-subagents block |
| TWO injection points | deployed pi ≠ pi-agent-cli; both need the floor |
| Patch in `pi-agent/src/patches/` | deployed pi's only extension point (patches → main) |
| Implement in `__ext` | user-confirmed proper git flow (deploy to __pi later) |
| Keep pi-agent-cli change | user-confirmed; bun-pi-agent-cli + zk-extract CLI honor floor too |
| Reject goal doc Phase 3 (TOOL_DEFAULT_MODELS) | wrong channel — flash trips weak-warning; over-engineered |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Goal doc claimed propagation bug | investigation | propagation works (resolveSubagentModel honors opts.model); real cause = TUI sets no OB_* env |
| Goal doc said edit `pi-agent-core` | investigation | no such package; deployed pi = pi-agent/src/cli.ts → patches |
| `bun .../cli.ts` direct run → module-not-found | diagnose | running .ts directly bypasses workspace resolution; the deployed shim runs from source fine |
| pi-agent-cli 4 test fails | stash test | pre-existing missing-module (research-tool/workflow ext), 0 new fails from change |
