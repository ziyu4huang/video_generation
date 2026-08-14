# Task 1 — Phase 2: present-as-view model + `webui:present` event handler + ledger fixes

- **Branch:** `hitl-webui-phase2` (from `origin/main`)
- **BASE:** `e7ecf680d444642ea6650f9f02270039917576fe` (expected `e7ecf680` — matched)
- **HEAD:** `81f6ca3c59ae673681b33641d512e1ec41c1bd57`
- **Status:** DONE (one minor plan-test deviation, documented below)

## Files changed (9 — exactly the plan's git add block)

| File | Change |
|---|---|
| `src/render-service.ts` | `Control` interface + optional `controls`/`presentId` on `RenderView`/`RenderInput` + two conditional spreads in `render()` |
| `src/render-routes.ts` | both `/api/view/:id` JSON branches (md + html) carry `controls`/`presentId` via conditional spreads; `viewSummary` + SSE untouched |
| `src/present-event-handler.ts` | CREATE — `createPresentEventHandler(registry)` + `PresentEventPayload`; validates, mints default `present` view, never throws |
| `src/webui-wiring.ts` | module-level `export type HitlResponse = { action: string; tweak?: string } \| { cancelled: true }`; `WebuiWiring.registerPending` returns `Promise<HitlResponse>`; closure-local `type HitlResponse` deleted; `registerPending` resolves a stale duplicate id as `{cancelled:true}` before re-keying; `createPresentEventHandler` import + registration (`const presentHandler` binding kept for Task 2); WS-close refresh-tension comment |
| `src/web-transport.ts` | stale `parseCommand` JSDoc refreshed (`respond` op shipped in Phase 1) |
| `tests/render-service.test.ts` | + new describe "present-as-view fields": round-trip + clean-shape tests |
| `tests/render-routes.test.ts` | + 3 tests: md present view, html present view, non-present clean shape |
| `tests/present-event-handler.test.ts` | CREATE — 4 tests (default mint, explicit view/mode/title, invalid mode, malformed payloads) |
| `tests/webui-wiring.test.ts` | + duplicate-id test in HITL describe; + new describe "webui:present event" (2 tests) |

## TDD evidence (red → green per step)

1. **render-service tests RED:** 1 fail — round-trip `toMatchObject` mismatch (`controls`/`presentId` absent from stored view). → **GREEN after impl:** 10 pass / 0 fail.
2. **render-routes tests RED:** 2 fail — `v.controls` undefined in md + html branches. → **GREEN after impl:** 12 pass / 0 fail.
3. **present-event-handler tests RED:** module-not-found error (`Cannot find module '../src/present-event-handler.js'`). → after creating impl: 3 pass / 1 fail — see Deviation #1. → **GREEN after test fix:** 4 pass / 0 fail.
4. **wiring tests RED:** run hung (90s command timeout) exactly as the plan predicted — the duplicate-id `await expect(first)` never resolves under the old `registerPending`. → **GREEN after impl:** 29 pass / 0 fail.
5. **Full gates:** `bun test` = **257 pass / 0 fail across 23 files**; `bun run build` (bunx tsc, src/**) = **exit 0**.

## Manifest VERIFY-ONLY step output (Step 18 — nothing changed)

```
dynamic extensions[]: ['pi-agent-ext-tool-gate', 'pi-agent-ext-devops', 'pi-agent-ext-flux2/extensions/flux2.ts', 'pi-agent-ext-krea2/extensions/krea2.ts', 'pi-agent-ext-ltx/extensions/ltx.ts', 'pi-agent-ext-research-tool', 'pi-agent-ext-zai-mcp', 'pi-agent-ext-movie-director', 'pi-agent-ext-archify']
staticExtensions: [..., 'pi-agent-ext-webui']
webui in dynamic: False
webui in staticExtensions: True
```
`grep` in `bun-apps/pi-agent/src/static-extensions.ts`: line 68 import + line 92 `{ name: "pi-agent-ext-webui", factory: webuiExtension }`.
**Verdict:** consistent single (static) registration; NOT in dynamic `extensions[]` → no double registration.

## Deviations

1. **present-event-handler malformed-payload test, final assertion.** The plan's verbatim test ends with `expect(registry.listViews()).toEqual([])` but its own preceding line asserts `{ content: "x", controls: [] }` is a VALID payload ("empty is VALID (schema-validated upstream)") — and the plan's verbatim handler implementation mints a view for it (empty array passes `every(isControl)`). The verbatim test therefore fails against the verbatim impl. Fixed the final assertion to match the plan's stated intent:
   ```ts
   expect(registry.listViews()).toMatchObject([{ id: "present", content: "x", controls: [] }]);
   ```
   Implementation unchanged from the plan. (Alternative — rejecting empty arrays in `isPayload` — would have contradicted the plan's explicit "empty is VALID" comment.)

2. Everything else is verbatim from the plan, including the multi-line commit message.

## Concerns

- None blocking. The WS-close refresh tension is DOCUMENTED in code (behavior unchanged), per the plan's Global Constraints.
- `const presentHandler` binding is in place for Task 2's `present` closure (no-event-bus fallback).
- All edits were located by symbol/content (post-#1300 base), as instructed; `createRenderRoutes`'s new `opts` param (heartbeatMs) did not interact with the view-JSON edits.

## Report

Not committed (per task instructions). Controller coordinates Task 2 + review on `hitl-webui-phase2`.
