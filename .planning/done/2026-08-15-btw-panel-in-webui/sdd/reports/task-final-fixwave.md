# Final-review fix wave (F1-F4)

Task: `zk-spawn` — mechanical completion of the final-review fix wave (test, report, ledger, commit).
All code landed on disk across two implementer dispatches (the first died after source edits; the second added tests); this dispatch tested and committed.

## F1 — Cross-package channel parity test (Important)

The final review flagged the channel-contract pin in `pi-agent-ext-btw` as self-referential: the btw side pinned its own channel names against itself, so a drift between the btw channel constants and the webui render-shell constants would go unnoticed. The fix wave added `bun-apps/pi-agent-ext-btw/__tests__/webui-channel-parity.test.ts`, which (a) imports the webui channel constants via a relative cross-package import and asserts they equal the btw-side constants, and (b) source-scans the webui render-shell for hardcoded `@repo/pi-agent-ext-btw` references so any future bypass of the shared constants fails loudly. This closes the last contract-drift hole between the two packages.

## F2 — Per-turn streaming status reset

Snapshots folded the streaming-status override from the previous turn into a new turn, so a new turn's live message could render as non-streaming until the first sub-session event arrived. `src/btw/session.ts` now resets `webuiStatus` on `turn_start`, guaranteeing the new turn's live message starts in streaming state. The covering case lives in `webui-bridge.test.ts` ("resets webuiStatus per turn so a new turn's live message streams again").

## F3 — model-not-found emitNotice

`handleWebuiCommand` swallowed model-not-found errors without surfacing them to the webui user; the webui side saw nothing happen. It now routes the failure through `emitNotice` on the webui event channel so the panel shows a visible notice. The covering case lives in `webui-command.test.ts`.

## F4 — Inline escape alignment

The render-shell's inline esc helper had drifted from the 4-replace `escapeHtml` used elsewhere, leaving one escape class inconsistent. `src/render-shell.ts` now runs the same 4-replace sequence as `escapeHtml`, aligning both paths. (`+2/-1` in render-shell.)

## Gate results

- `( cd bun-apps/pi-agent-ext-btw && bun run test )`: **36 pass / 0 fail** — 118 expect() calls across 8 files (includes new webui-channel-parity.test.ts, new webui-bridge and webui-command cases).
- `( cd bun-apps/pi-agent-ext-webui && bun run test )`: **319 pass / 0 fail** — 701 expect() calls across 27 files.

Both gates green; fix wave complete.
