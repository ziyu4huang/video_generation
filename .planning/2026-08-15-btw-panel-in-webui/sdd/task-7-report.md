# Task 7 Report: snapshot store + broadcast forwarder

## Status
COMPLETE — implemented per brief, all tests green, committed.

## Commits
- `feat(webui): add btw latest-snapshot store and broadcast forwarder` (single commit on `feat/btw-panel-in-webui`, parent `618ee8bc`)

## What was built
- `bun-apps/pi-agent-ext-webui/src/btw-store.ts`
  - `BtwStore` interface: `apply(event: BtwEvent): void` + `state(): BtwThreadState`
  - `createBtwStore()`: latest-snapshot store; only `thread` events replace the snapshot; `notice` events never clobber it; defaults to an empty `contextual` thread (`messages: []`, `model: null`, `thinking: null`)
  - `createBtwForwarder(store, broadcast)`: returns `(event: BtwEvent) => void` that applies the event to the store and re-broadcasts it as the outbound `BtwWebFrame` `{ type: "btw", event }` (Task 6 protocol)
- `bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts` — 3 tests, verbatim from the brief

## TDD trail
1. Wrote the test verbatim → `bun test tests/btw-store.test.ts` → FAIL (cannot resolve `../src/btw-store`) ✅
2. Wrote the minimal implementation → focused run: **3 pass / 0 fail** ✅
3. Full gate `( cd bun-apps/pi-agent-ext-webui && bun run test )` (tsc + unit): first run caught `TS2835` — the package uses `moduleResolution: nodenext`, so relative imports need explicit `.js` extensions (same convention as `src/protocol.ts` and `tests/protocol-btw.test.ts`). Added `.js` to the import specifiers in both new files.
4. Final full gate: **302 pass / 0 fail** across 24 files (656 expect calls) ✅

## Deviations from brief
- Only deviation: import specifiers carry explicit `.js` extensions (`./protocol.js`, `./btw-channels.js`) instead of the brief's extensionless form — required by the package's `tsc` build (nodenext); no semantic change.

## Verification of contract points
- `BtwEvent` / `BtwThreadState` shapes match `src/btw-channels.ts` (Task 5): `thread`/`notice` variants; `messages | mode | model | thinking`.
- `{ type: "btw", event }` matches `BtwWebFrame` in `src/protocol.ts` (Task 6) and is a member of the `WebFrame` union accepted by `server.broadcast(frame: WebFrame): void`.
- Pull-then-subscribe (D7): the store is the source for Task 8's `GET /api/btw`.

## Concerns
None. The store holds a reference (not a deep copy) to the event's `state` — fine here since `BtwEvent` payloads are treated as immutable snapshots on the bus; Task 8 reads it read-only.
