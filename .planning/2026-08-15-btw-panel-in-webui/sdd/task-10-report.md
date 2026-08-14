# Task 10 Report — shell client logic (pull-then-subscribe, first inbound WS consumer, command sends)

## Status

Complete. Commit `7015f88d` (amended to include planning artifacts) on `feat/btw-panel-in-webui`.

## What was implemented

All in `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (`RENDER_SHELL_HTML` `<script>` block), plus 4 new test cases in `tests/render-shell-btw.test.ts`:

1. **Failing tests first (TDD)** — appended the brief's `RENDER_SHELL_HTML btw client logic` describe block verbatim; confirmed 3 of 4 new cases fail before implementation (the SSE case already passed).
2. **First inbound WS consumer** — `ws.onmessage` assigned inside `connectWs()` (so every reconnecting socket instance gets it), parsing JSON frames and dispatching `{ type: "btw", event }` to `btwApplyEvent`. Exactly one `new WebSocket(` construction site remains (guarded by test).
3. **sendRaw extraction** — `sendAppexecResponse`'s inline `ws.send` + readyState check extracted into `sendRaw(payload)`; `sendAppexecResponse` and `sendBtw` both route through it. No second socket, no duplicated reconnect logic.
4. **sendBtw(kind, extra)** — builds the FLAT `{ type: 'btw', kind, ...extra }` frame (no nested `extra` wrapper, undefined keys omitted) per `BtwCommandFrameSchema`, stringified via `sendRaw`.
5. **Pull-then-subscribe** — `btwInit()` fetches `GET /api/btw` (thread snapshot → `btwRenderMessages`) and `GET /api/btw/models` (dropdown fill, index-valued options, "Main session model" default), called at the end of the init IIFE after `refresh()`/`subscribe()`.
6. **Render pipeline** — `btwRenderMessages` append/patch/prune keyed by `data-id` (outerHTML patch for existing rows, removal of unseen rows, autoscroll); `btwMessageHtml` is the inlined duplicate of `BTW_MESSAGE_HTML` (same intentional duplication pattern as `APPEXEC_FRAME`); `btwApplyEvent` handles `thread` (state swap + re-render + mode button label) and `notice` (escaped notice row).
7. **Wiring** — collapse toggle persists `localStorage["btw-panel-collapsed"]` ('1'/'0') and `btwApplyCollapsed()` applies it on load (was only a CSS contract comment after Task 9); ask/new/clear/inject/summarize/mode/model/thinking handlers send via `sendBtw`.

## Deviations from the brief's verbatim snippet

- **`frame.type === "btw"` uses double quotes** in the `ws.onmessage` handler: the brief's Step 1 test asserts `toContain('frame.type === "btw"')` while its Step 3 snippet used single quotes — contradiction; the test is binding, so double quotes win (harmless inside the TS template literal).
- **`sendRaw` extracted** rather than duplicating the readyState-guarded send inside `sendBtw` (brief explicitly allows/encourages this).
- Shell style adapted (const/let, null-guarded `getElementById` before `addEventListener`) — all test-asserted literals preserved exactly.
- Notice rows also autoscroll the message list (brief snippet set `scrollTop` only on thread renders; small consistency win, no contract impact).

## Test results

- Focused: `bun test tests/render-shell-btw.test.ts` → 10 pass, 0 fail (5 Task 9 + 4 new + …; counts as plan predicted).
- Package gate: `bun run test` → **316 pass, 0 fail** across 26 files.

## Concerns / notes for review

- `btwMessageHtml` (inline) still interpolates `m.id` / `m.role` unescaped — carried over deliberately from Task 9's plan-verbatim helper; Task 9 progress notes flag hardening for Task 10/11. Since ids/roles originate server-side (btw package), the exposure is internal; recommend hardening both copies together in a later pass.
- `btwState.model` / `btwState.thinking` from the snapshot are not reflected into the `<select>` UI on load (the snapshot drives messages + mode only, matching the brief's verbatim snippet). If the server later sends selections, Task 11 or a follow-up can sync the dropdowns.
- Model selection sends `{ provider, id, api }` derived from the last `/api/btw/models` fetch; if the list is stale the engine is expected to reject unknown models (server-side concern).
