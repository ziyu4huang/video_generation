# Progress Log — Distill fast-model configuration

## Session 1 — 2026-07-10

### Investigation (Phase 0)
- Goal doc (`output/next-goal-20260710-211013.md`) premise "propagation bug" → **WRONG**.
  `resolveSubagentModel` (obsidian.ts:2984) honors `opts.model`; flux2+gemma success proved it.
- `deepseek-v4-flash` matches `/flash/i` → WEAK; must be a FLOOR (`OB_SUBAGENT_MODEL`,
  never weakness-checked), NOT per-call `--model` (trips weak-warning). Rejects goal doc Phase 3.
- TWO subagent systems: pi-obsidian `runSubagent` (uses OB_* env = distill path) vs
  ext-subagents `agentOverrides` (named agents, NOT distill). Goal doc conflated them.
- **ROOT CAUSE**: deployed `pi` = `pi-agent/src/cli.ts` → pi-coding-agent `main()`.
  The TUI sets NEITHER `OB_PARENT_MODEL` NOR `OB_SUBAGENT_MODEL` (0 hits in dist) →
  every no-`--model` distill hits path 4: warning + slow inherited model → timeouts.
- `pi-agent-cli` is a SEPARATE secondary CLI (`bun-pi-agent-cli`); its `shared.ts:400`
  sets OB_PARENT_MODEL but the deployed pi doesn't use it.
- Deployed pi extension point = `pi-agent/src/patches/` (env-gated, PATCH_TABLE + switch).
- Multi-worktree: `__pi` (deployed, branch feat/workflow-default-enabled) vs `__ext`
  (this, detached origin/main). Shim runs `__pi` from source (no rebuild).

### Decisions (with user)
- Approach A (settings floor, minimal) + model deepseek-v4-flash ✓
- Implement in `__ext` (proper git flow) ✓; keep pi-agent-cli change ✓

### Implementation
- **pi-agent-cli/src/sessions/shared.ts**: `applyObsidianSubagentFloor(settings)` (exported,
  pure) + `readUserSettings()`; called in `createSharedSession` before OB_PARENT_MODEL.
  → shared.test.ts: +6 tests (18/18 pass).
- **pi-agent/src/patches/subagent-model-floor.ts**: `resolveSubagentFloor()` (pure) +
  import-time side effect (settings → OB_SUBAGENT_MODEL; env wins).
  → subagent-model-floor.test.ts: 11/11 pass.
- **pi-agent/src/patches/index.ts**: registered (PatchName + PATCH_TABLE after
  ensure-extension-deps + switch case). index.test.ts covers-all list updated.
- **~/.pi/agent/settings.json**: added `obsidian.subagentModel = deepseek/deepseek-v4-flash`.

### Validation
- pi-agent: 184 pass / 0 fail / 54 e2e-skip — 0 regressions.
- pi-agent-cli shared.test.ts: 18/18 pass. (4 unrelated pre-existing fails confirmed via stash.)
- applyPatches integration test imports the real patch module → import-safe (getAgentDir OK).
- **Empirical**: `zk_extract --model deepseek-v4-flash` on power-tool PRD → 5 cards, 12
  cross-links, MOC-indexed, NO timeout. deepseek-v4-flash confirmed fast + reliable.

### Docs
- pi-cross-machine-setup.md: added "Distill/garden subagent model floor" section +
  BUN_PI_SUBAGENT_MODEL_FLOOR in patch-toggles table.

## Files changed
| File | Change |
|------|--------|
| `bun-apps/pi-agent-cli/src/sessions/shared.ts` | +applyObsidianSubagentFloor + readUserSettings + call |
| `bun-apps/pi-agent-cli/src/__tests__/shared.test.ts` | +6 tests |
| `bun-apps/pi-agent/src/patches/subagent-model-floor.ts` | NEW patch |
| `bun-apps/pi-agent/src/patches/subagent-model-floor.test.ts` | NEW 11 tests |
| `bun-apps/pi-agent/src/patches/index.ts` | register patch (3 spots) |
| `bun-apps/pi-agent/src/patches/index.test.ts` | covers-all list +1 |
| `bun-apps/pi-agent/docs/pi-cross-machine-setup.md` | +floor section +toggle |
| `~/.pi/agent/settings.json` | +obsidian.subagentModel |

## Deploy note (for user)
The patch is in `__ext`. To activate in the running pi (shim → `__pi` from source),
land the change on `__pi`'s branch (cherry-pick / merge) and restart pi. Until then,
distill with no `--model` still warns; `export OB_SUBAGENT_MODEL=deepseek/deepseek-v4-flash`
is the immediate zero-deploy workaround.

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | All 5 phases complete ✅ |
| Where am I going? | Done — deploy to __pi to activate the floor at runtime |
| What's the goal? | Persistent deepseek-v4-flash floor for distill via settings.json |
| What have I learned? | deployed pi ≠ pi-agent-cli; TUI sets no OB_* env; flash must be floor not --model |
| What have I done? | 2 injection points + settings + tests (0 regressions) + docs + empirical distill |
