# Task 2 (Phase 2) — `webui_present` blocking HITL tool + wiring composition

**BASE:** `81f6ca3c59ae673681b33641d512e1ec41c1bd57` (Task 1 commit, verified)
**HEAD:** `5d974e25d5c62dd341cae3980cdc3d1dae522bd3`
**Branch:** `hitl-webui-phase2` (not pushed; no PR per task instructions)

## Files (exactly 4 committed)

| File | Change |
|---|---|
| `bun-apps/pi-agent-ext-webui/src/present-tool.ts` | CREATE — `createPresentTool(deps)` factory: `PresentParameters` (TypeBox, REQUIRED `controls`), `PresentInput`/`PresentFn`/`PresentToolDeps`/`PresentToolDetails`, `nextPresentId()` → `present_<now>_<seq>`, `describeHitlResponse`, `awaitPendingWithAbort`, one-pending guard → error RESULT `{error:"already_pending"}`, branches on `cancelled` before `action`. |
| `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` | MODIFY — import `createPresentTool` + `type PresentInput`; `cancelPending(id)` closure after `cancelAllPending`; `present` closure (emit `webui:present` via `pi.events`, else direct `presentHandler` fallback) + `pi.registerTool?.(createPresentTool({present, registerPending, hasPending, cancelPending}))` after the Task-1 present-handler registration. |
| `bun-apps/pi-agent-ext-webui/tests/present-tool.test.ts` | CREATE — 11 fake-deps unit tests (schema shape, block+respond, tweak, mode/view/title forwarding, signal-abort, one-pending guard + release, id uniqueness, describeHitlResponse ×4). |
| `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` | MODIFY — new top-level describe after the `webui:present` describe: `presentToolOf(pi)` helper + 3 MockPi integration tests (present→view minted→appexec respond resolves {action,tweak}; second present → error result + first survives shutdown; session_shutdown mid-pending → cancelled). |

All code verbatim from `plan-phase2.md` Task 2 (Steps 1/3/5/7). Edits located by symbol, not line.

## TDD evidence

1. **Red (unit):** `bun test tests/present-tool.test.ts` → `error: Cannot find module '../src/present-tool.js'`, 1 fail.
2. **Green (unit):** after creating `src/present-tool.ts` → 11 pass / 0 fail.
3. **Red (integration):** after adding the describe to `webui-wiring.test.ts` → 29 pass / **3 fail** (all three `webui_present blocking gate` tests — tool not yet registered).
4. **Green (integration):** after wiring → 32 pass / 0 fail.

## Full gates

- `bun test` (whole package): **271 pass / 0 fail** across 24 files.
- `bun run build` (`bunx tsc`): **exit 0**.

## Deviations

None. All steps executed in order per the plan; no files touched outside the 4 committed ones; preserved files untouched.

## Concerns

None. (Type-only `HitlResponse` import in present-tool.ts creates no runtime cycle; guard soundness holds — no `await` between `hasPending()` and `registerPending`.)
