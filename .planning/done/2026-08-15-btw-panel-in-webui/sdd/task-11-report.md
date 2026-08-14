# Task 11 Report — cross-package contract test

## Status
Complete. Test file created verbatim per brief, package gate green, committed.

## What was implemented
`bun-apps/pi-agent-ext-webui/tests/btw-contract.test.ts` — a contract test exercising BOTH packages' bus-facing seams against a fake `{ on, emit }` bus with NO import between the two packages:

1. **Channel-name pinning**: webui's `BTW_COMMAND_CHANNEL` / `BTW_EVENT_CHANNEL` (from `src/btw-channels.ts`) must equal the btw package's published literals (`"webui:btw-command"` / `"btw:event"`, redeclared verbatim from `pi-agent-ext-btw/src/btw/webui-events.ts`). The deliberate string duplication IS the contract — if either package renames a channel, this test fails.
2. **End-to-end drive** (ask → snapshot → frame): a fake btw-side engine subscribes on the command channel and emits a pre-reduced `BtwThreadState` snapshot on the event channel; webui's real `onBtwEvent` + `createBtwForwarder` + `createBtwStore` consume it — the snapshot lands in the pull store AND broadcasts as `{ type: "btw", event }`; `emitBtwCommand({ kind: "ask", ... })` flows back over the command channel to the fake engine.
3. **Decoupling assertion**: webui `package.json` declares no `@repo/pi-agent-ext-btw` in `dependencies` or `devDependencies` (read at test time, so a future accidental `bun add` fails the gate).

## Hard-constraint compliance
- No import of `@repo/pi-agent-ext-btw` anywhere in webui package code or `package.json` — btw side is represented purely by locally redeclared channel literals + a test-local fake engine (the brief's chosen mechanism).
- No real model calls anywhere (pure fake bus).
- Artifacts in English.

## Verification
- Focused: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-contract.test.ts )` → **3 pass, 0 fail**
- Package gate: `( cd bun-apps/pi-agent-ext-webui && bun run test )` (build + full suite) → **319 pass, 0 fail** (27 files, 701 expect calls)
- Test passed immediately, as the brief predicted (it pins Tasks 1/5/7 output) — no seam changes were needed.

## Commits
- `test(webui): pin the btw/webui bus contract without package coupling` (includes test file + brief/report/progress planning artifacts, force-added per standing rule)

## Concerns
None. The contract-test mechanism relies on the redeclared literals staying in sync with the btw package source; the channel-name pinning test is exactly what enforces this, and the duplication is intentional per the brief.
