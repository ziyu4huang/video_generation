### Task 12: final verification — both gates + dependency sweep

**Files:**
- No new files. Verification only (fix and re-commit if anything below fails).

**Interfaces:**
- Consumes: everything from Tasks 1–11.
- Produces: green gates in both packages + proof of no cross-package coupling.

- [ ] **Step 1: Run the btw package gate**

Run: `( cd bun-apps/pi-agent-ext-btw && bun run test )`
Expected: PASS — new webui-seam tests plus ALL pre-existing tests (registration, extension-contract, markdown-render) green → TUI regression-free.

- [ ] **Step 2: Run the webui package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — all 16 pre-existing test files plus the 6 new test files green.

- [ ] **Step 3: Verify no cross-package coupling**

Run: `( git grep -n "pi-agent-ext-btw" -- bun-apps/pi-agent-ext-webui/src bun-apps/pi-agent-ext-webui/package.json ; git grep -n "from ['\"]@repo/pi-agent-ext" -- bun-apps/pi-agent-ext-webui/src )`
Expected: NO matches in `src/` or `package.json` (the only allowed mentions are in `tests/btw-contract.test.ts` comments).

- [ ] **Step 4: Verify no real-model test calls**

Run: `( git grep -rn "prompt(" -- bun-apps/pi-agent-ext-btw/__tests__ bun-apps/pi-agent-ext-webui/tests | grep -v "sendUserMessage\|summarizeThread\|session.prompt" )`
Expected: NO matches — every test uses fake sessions, recording mocks, or pure helpers.

- [ ] **Step 5: Confirm a clean tree**

Run: `git status --short`
Expected: empty (every task committed). If stragglers exist, `git add` their exact paths and commit with `chore: finalize btw panel effort leftovers`.

## Self-Review

**1. Spec coverage** — each spec requirement maps to a task:

- Component 1 (btw event API over `pi.events`): Tasks 1–4 (channels/types, pre-reduction, thread-event emission, command subscription + ctx capture). No new tools registered anywhere (D2); sub-session tools untouched (D10).
- Component 2 (webui command ingestion + WS frame forwarding): Tasks 5–8 (seam redeclaration, TypeBox frame + `parseCommand` → dispatch, store + broadcast forwarder, wiring glue incl. `dispatch` case `"btw"`).
- Component 3 (GET /api/btw + /api/btw/models): Task 8 (route handler, pull-then-subscribe store per D7, registry-backed model list per D12, `WebuiSessionCtx` widened to expose `modelRegistry`).
- Component 4 (panel UI): Tasks 9–10 (flex-row side panel, collapse toggle persisted in `localStorage` per D1, message list append/patch keyed by snapshot id per D5, declarative button bar New/Clear/Inject/Summarize + mode toggle per D11/D13, Model dropdown per D12, Thinking toggle, no slash syntax).
- Cross-package contract test: Task 11 (chosen form documented above and in Phase context).
- All 8 command surfaces: ask (Task 10 send + Task 4 `runBtw`), new/clear/inject/summarize (Task 4 via `dispatchBtwCommand`, exact TUI semantics), model (Task 4 via `setBtwModelOverride` + `ctx.modelRegistry.find`), thinking (Task 4 via `setBtwThinkingOverride`), tangent-as-mode-toggle (Task 4 mode case + Task 10 button). Refresh/second-tab restore: D7 pull (`/api/btw` in Task 8, pulled in Task 10) + subscribe (initial thread event at `session_start`, Task 4; store, Task 7). Inject confirmation: notice event (Tasks 3–4) rendered by the panel (Task 10) — D9's "main transcript unrendered" gap is accepted per spec.
- Testing decisions: event-bus seams, HTTP routes, WS frame shape, shell string/pure-helper tests — all present; no real model anywhere (Task 12 Step 4 double-checks).
- No gaps found against D1–D13.

**2. Placeholder scan** — no "TBD"/"TODO"/"similar to Task N"/unguarded "add error handling" steps. Every code step contains full runnable code. The four documented soft spots (AgentMessage part shape, SessionModel field names, SessionThinkingLevel union width, SDK type import specifiers) each name the exact in-repo file to mirror and require keeping both sides consistent — they are flagged adjustments, not invented APIs.

**3. Type consistency** — verified across all tasks: channel strings `"webui:btw-command"` / `"btw:event"` identical in Tasks 1, 4, 5, 8, 10, 11; `BtwCommand`/`BtwEvent`/`BtwThreadState`/`BtwMessageSnapshot` field names identical between `src/btw/webui-events.ts` (Task 1) and `src/btw-channels.ts` (Task 5); frame shapes consistent: inbound flat `{ type: "btw", kind, text?, mode?, model?, level? }` in Tasks 6 (schema), 9 (`BTW_FRAME`), 10 (`sendBtw`); outbound `{ type: "btw", event: BtwEvent }` in Tasks 6 (`BtwWebFrame`), 7 (forwarder), 10 (`ws.onmessage`), 11 (contract); snapshot ids `btw-m-<i>`/`btw-d-<i>` consistent between Task 2 (derivation), Task 3 (emission), Task 9 (`data-id` rows), Task 10 (append/patch); localStorage key `"btw-panel-collapsed"` consistent in Tasks 9–10; `BtwModelSummary`/`BtwModelRef` share `provider`/`id`/`api` in Tasks 1, 5, 8, 10.

**4. Post-review patch (2026-08-15)** — two blocking fixes adopted from dual plan reviews: (a) Task 10 Step 1's WebSocket assertion replaced with an occurrence-count guard (`split("new WebSocket(").length - 1).toBe(1)`) since the existing shell already contains one `new WebSocket(` construction; (b) Task 2's tool-name field corrected from `name` to the real SDK field `toolName` (fixtures + `statusFromEvent` implementation). Two advisory fixes also adopted: Task 2's unconditional `tool_execution_end` → "streaming" mapping is now documented as a deliberate simplification (real code gates on `session.isStreaming`), and Task 10 Step 3's `sendBtw` verbatim snippet rebuilt as the flat frame (defined keys only) to match the placement note.
