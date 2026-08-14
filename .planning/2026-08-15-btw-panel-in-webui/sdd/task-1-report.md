# Task 1 Report — btw channel constants + payload types

Status: DONE

## What was implemented

Per `.planning/2026-08-15-btw-panel-in-webui/sdd/task-1-brief.md`, verbatim:

- Created `bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts` — event-bus seam module exporting:
  - `BTW_COMMAND_CHANNEL = "webui:btw-command"`, `BTW_EVENT_CHANNEL = "btw:event"` (both `as const`)
  - Types: `BtwThreadMode`, `BtwModelRef`, `BtwThinkingLevel`, `BtwCommand` (8-kind discriminated union), `BtwMessageStatus`, `BtwMessageSnapshot`, `BtwThreadState`, `BtwEvent` (`thread` | `notice`)
  - Guard: `isBtwCommand(data: unknown): data is BtwCommand` (kind allowlist + `ask`/`text` and `mode`/mode-value validation)
- Created `bun-apps/pi-agent-ext-btw/__tests__/webui-events.test.ts` — 4 tests: channel names, command JSON-safety round-trip, event JSON-safety round-trip, guard accept/reject.

## TDD evidence

**RED** — `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-events.test.ts )`:

```
error: Cannot find module '../src/btw/webui-events' from '.../__tests__/webui-events.test.ts'
 0 pass
 1 fail
 1 error
```

**GREEN** — same command after implementation:

```
 4 pass
 0 fail
 32 expect() calls
Ran 4 tests across 1 file. [12.00ms]
```

## Canonical gate

`( cd bun-apps/pi-agent-ext-btw && bun run test )`:

```
 15 pass
 0 fail
 58 expect() calls
Ran 15 tests across 4 files. [209.00ms]
```

`bun run typecheck` (tsc --noEmit): clean, no errors.

## Files changed

- `bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts` (new)
- `bun-apps/pi-agent-ext-btw/__tests__/webui-events.test.ts` (new)
- `.planning/2026-08-15-btw-panel-in-webui/sdd/progress.md` (ledger line appended)
- `.planning/2026-08-15-btw-panel-in-webui/sdd/task-1-report.md` (this report)

## Self-review findings

- Both files are verbatim copies of the brief's code blocks; all exported names and shapes match the brief exactly (binding contract for Tasks 2-12).
- No overbuild: no extra exports, no imports beyond `bun:test`.
- Verified the module did not previously exist (`src/btw/` had constants/index/overlay/session/transcript/types only).

## Concerns

None.
