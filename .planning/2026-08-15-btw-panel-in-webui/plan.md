# btw Side Panel in the webui — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the btw tangent-thread extension in the browser webui as a persistent, collapsible side panel with full 8-command parity, streaming message snapshots, and refresh-safe restore — without any package dependency from webui to btw.

**Architecture:** webui-led, additive seams only. btw gains a minimal event API over the SDK shared event bus (`pi.events`): it subscribes to a command channel and emits pre-reduced thread snapshots on an event channel. webui translates inbound WS `btw` frames into command-channel events, forwards thread events as a new `btw` WS frame + keeps a latest-snapshot store served by `GET /api/btw` (pull-then-subscribe), and extends `RENDER_SHELL_HTML` with the panel. The TUI overlay path is untouched.

**Tech Stack:** TypeScript (Bun), TypeBox (webui protocol — NOT zod), vanilla-JS inline shell, pi SDK `EventBus` (plain string channels, `on()` returns disposer), `Bun.serve` + WebSockets.

## Global Constraints

Each task's requirements implicitly include all of the following — they are binding, copied from the spec's decisions D1–D13 and testing decisions:

- **No package dependency webui → btw.** No `bun add` cross-links between `bun-apps` packages; the webui package must never import from `@repo/pi-agent-ext-btw`. The seam is string channel names + JSON-safe payloads, mirroring the `webui:render` / `webui:present` style.
- **User-only triggers (D2).** No new agent-facing btw tools are registered; the sub-session keeps exactly the tools `read`/`bash`/`edit`/`write` (D10).
- **Server posture (D10).** The webui server stays loopback-only; token auth stays OFF. Do not widen exposure while the sub-session can run `bash`.
- **TUI regression-free.** btw's overlay + 8 slash commands behave exactly as before; all existing btw tests stay green. Every btw change is an additive seam, never a modification of the overlay/`applyTranscriptEvent` path.
- **Pull-then-subscribe (D7).** `GET /api/btw` returns the current thread snapshot; the panel pulls on load, then applies pushed events.
- **Single active thread (D8).** One active btw thread mirrors the engine's single active session; **New** replaces it via the engine's existing dispose-on-mode-change semantics.
- **Wire format (D5).** btw pre-reduces sub-session `AgentSessionEvent`s into message snapshots; the shell only appends/patches — no shell-side transcript reducer.
- **No test may call a real model.** Tests use fake sessions (`subscribe(cb)` + synthetic event pushes), recorder/recording mocks, pure helpers, and real-server `fetch` — all model-free.
- **TypeBox, not zod, in webui protocol code.**
- **Gates:** `( cd bun-apps/pi-agent-ext-btw && bun run test )` and `( cd bun-apps/pi-agent-ext-webui && bun run test )` (each = build + unit). `check:schema` does NOT exist in pi-agent-ext-webui — not applicable. If a package ever lacks the `test` script, the equivalent is its `build` (tsc) + `bun test`.
- **English artifacts.** All code, comments, commit messages, and file content in English.
- **First-use notes.** The shell's btw collapse toggle is the FIRST `localStorage` use in render-shell.ts (key `"btw-panel-collapsed"`); the btw `ws.onmessage` handler is the FIRST inbound consumer of the browser `/ws` socket (today it is send-only; SSE `/api/events` stays exactly as-is).

## Phase context

Phases (tasks may be grouped under these headings):

- **Phase 1 — btw event API** (Tasks 1–4): channel contract, snapshot reduction, engine emission bridge, command subscription.
- **Phase 2 — webui transports** (Tasks 5–8): local channel redeclaration, protocol/transport frame, snapshot store + forwarder, HTTP routes + wiring glue.
- **Phase 3 — panel UI** (Tasks 9–10): shell markup + pure helpers, shell client logic.
- **Phase 4 — contract + gates** (Tasks 11–12): cross-package contract test, full verification.

**Chosen names (ONE consistent set across all tasks — do not rename mid-plan):**

- Command channel (webui emits, btw subscribes): `BTW_COMMAND_CHANNEL = "webui:btw-command"`.
- Thread-event channel (btw emits, webui subscribes): `BTW_EVENT_CHANNEL = "btw:event"`.
- Command payload `BtwCommand`: `{ kind: "ask"; text: string } | { kind: "new" } | { kind: "clear" } | { kind: "inject" } | { kind: "summarize" } | { kind: "model"; model: BtwModelRef | null } | { kind: "thinking"; level: BtwThinkingLevel | null } | { kind: "mode"; mode: BtwThreadMode }` where `BtwModelRef = { provider: string; id: string; api: string }`, `BtwThinkingLevel = "off" | "low" | "medium" | "high"`, `BtwThreadMode = "contextual" | "tangent"`.
- Event payload `BtwEvent`: `{ type: "thread"; state: BtwThreadState } | { type: "notice"; text: string }` where `BtwThreadState = { messages: BtwMessageSnapshot[]; mode: BtwThreadMode; model: BtwModelRef | null; thinking: BtwThinkingLevel | null }` and `BtwMessageSnapshot = { id: string; role: "user" | "assistant"; text: string; status: "streaming" | "running-tool" | "done" | "error"; statusText?: string }`.
- Outbound WS frame: `{ type: "btw"; event: BtwEvent }` (new `BtwWebFrame` member of the `WebFrame` union), broadcast via the existing `server.broadcast(frame)`.
- Inbound WS frame: flat TypeBox `BtwCommandFrameSchema` `{ type: "btw"; kind: ...; text?; mode?; model?; level? }` → `parseCommand` → DispatchAction member `{ kind: "btw"; command: BtwCommand }`.
- Snapshot ids: `btw-m-<index>` (live sub-session messages), `btw-d-<index>` (persisted `BtwDetails` fallback) — index-keyed so the shell can append/patch by id.
- btw package seam module: `src/btw/webui-events.ts` (consts + payload types + `isBtwCommand` guard). webui package seam module: `src/btw-channels.ts` (LOCAL redeclaration — no import from btw) + bus helpers `emitBtwCommand` / `onBtwEvent`.
- Panel localStorage key: `"btw-panel-collapsed"` (`"1"` = collapsed).

**Documented design choices:**

- **Pre-reduction (D5)**: a dedicated module `src/btw/snapshot.ts` (not a second full reducer over `applyTranscriptEvent`). The engine bridge re-derives snapshots from `activeBtwSession.session.agent.state.messages` on each sub-session event (cheap for a side thread) and folds a `BtwStatusUpdate` (from `statusFromEvent`) into the last message; when no session is live it derives from `pendingThread: BtwDetails[]`. This keeps the TUI `applyTranscriptEvent`/overlay path byte-identical.
- **Engine bridge independence**: `subscribeWebuiBridge(sr)` adds its OWN `sr.session.subscribe(...)` callback (tracked in `sr.subscriptions`), separate from `subscribeOverlayToActiveBtwSession`. It never calls `applyTranscriptEvent`, `setOverlayStatus`, or `syncUi` — zero TUI surface touched.
- **Load-order rationale**: webui subscribes to `btw:event` during its extension factory (before any `session_start` fires); btw emits an initial thread event at the tail of its existing `session_start`/`session_tree` restore handlers — so the webui store is seeded regardless of factory order.
- **Command mapping**: `ask`/`new`/`clear`/`inject`/`summarize` reuse `runBtw` / `dispatchBtwCommand` (exact TUI semantics); `model`/`thinking` call `setBtwModelOverride`/`setBtwThinkingOverride` directly (resolved via `ctx.modelRegistry.find`); `mode` sets `pendingMode` + disposes the active session (mirrors the engine's dispose-on-mode-change rebuild semantics).
- **Contract-test form**: a webui-package test (`tests/btw-contract.test.ts`) that redeclares the btw-side channel strings locally, wires BOTH seams against a plain `{ on, emit }` fake bus (webui's real `createBtwStore`/`createBtwForwarder`/`onBtwEvent`/`emitBtwCommand` + a test-local fake btw-side subscriber/emitter), and additionally asserts `package.json` declares no `@repo/pi-agent-ext-btw` dependency. No import between the two packages exists anywhere.
- **Known soft spots (implementer verifies against source, plan cannot invent APIs silently)**: (a) exact `AgentMessage` part shape for text extraction in `snapshotsFromMessages` — mirror the extraction already used in `src/btw/session.ts` (`runBtw`'s answer extraction / `getBtwHandoffThread`'s live-message walk) and keep the test fixture in sync; (b) `SessionModel` field names for the `BtwModelRef` mapping — mirror the override-entry payload construction in `setBtwModelOverride`; (c) the `SessionThinkingLevel` union — if the SDK's differs from `"off"|"low"|"medium"|"high"`, widen `BtwThinkingLevel` in BOTH seam modules identically; (d) the SDK import specifier for `AgentSessionEvent`/`ModelRegistry` types — copy the import path already used in `src/btw/session.ts` / `src/webui-wiring.ts`.

## File Structure

**pi-agent-ext-btw** (`bun-apps/pi-agent-ext-btw/`):

- Create `src/btw/webui-events.ts` — channel consts, payload types, `isBtwCommand` guard. Pure types/constants; no engine imports.
- Create `src/btw/snapshot.ts` — `snapshotsFromDetails`, `snapshotsFromMessages`, `statusFromEvent`, `BtwStatusUpdate`.
- Create `__tests__/helpers/fake-pi.ts` — recording fake `ExtensionAPI` (event bus + `appendEntry` + `on`-handler triggers) shared by the new btw tests.
- Modify `src/btw/session.ts` — additive engine fields (`latestCtx`, `webuiStatus`, `webuiBridgedFor`) + methods `setLatestCtx`, `subscribeWebuiBridge`, `emitThreadEvent`, `emitNotice`, `buildThreadState`, `handleWebuiCommand`; hook `subscribeWebuiBridge` into `createBtwSubSession`; clear `webuiStatus` in `disposeBtwSession`.
- Modify `src/btw/index.ts` — capture ctx + emit initial thread event in `session_start`/`session_tree`; subscribe to `BTW_COMMAND_CHANNEL`.
- Create `__tests__/webui-events.test.ts`, `__tests__/snapshot.test.ts`, `__tests__/webui-bridge.test.ts`, `__tests__/webui-command.test.ts`.

**pi-agent-ext-webui** (`bun-apps/pi-agent-ext-webui/`):

- Create `src/btw-channels.ts` — local channel consts + payload types (redeclared, no btw import), `isBtwEvent`, `btwCommandFromFrame`, `emitBtwCommand`, `onBtwEvent`.
- Create `src/btw-store.ts` — `createBtwStore` (latest-snapshot store), `createBtwForwarder` (store.apply + broadcast `{type:"btw"}` frame).
- Create `src/btw-routes.ts` — `createBtwRoutes({ getState, getModels })` HTTP handler for `GET /api/btw` + `GET /api/btw/models`.
- Modify `src/protocol.ts` — `BtwCommandFrameSchema` (+ union member), `BtwCommandFrame`, `BtwWebFrame` WebFrame member.
- Modify `src/web-transport.ts` — `parseCommand` case for `btw` frames → DispatchAction `{ kind: "btw"; command }`.
- Modify `src/webui-wiring.ts` — widen `WebuiSessionCtx` with `modelRegistry`; subscribe `onBtwEvent` → forwarder → `server.broadcast`; `dispatch` case `"btw"` → `emitBtwCommand`; chain `createBtwRoutes` into `setHttpRoutes`.
- Modify `src/render-shell.ts` — panel markup + CSS in `RENDER_SHELL_HTML`; pure helpers `BTW_FRAME`, `BTW_MESSAGE_HTML`; shell client JS (pull-then-subscribe, first `ws.onmessage`, command sends, localStorage collapse).
- Create `tests/btw-channels.test.ts`, `tests/btw-store.test.ts`, `tests/btw-routes.test.ts`, `tests/protocol-btw.test.ts` (or extend the existing protocol/transport test files), `tests/render-shell-btw.test.ts`, `tests/btw-contract.test.ts`.

---

## Phase 1 — btw event API

### Task 1: btw channel constants + payload types

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts`
- Test: `bun-apps/pi-agent-ext-btw/__tests__/webui-events.test.ts`

**Interfaces:**
- Consumes: nothing (first task of the effort).
- Produces: `BTW_COMMAND_CHANNEL = "webui:btw-command"`, `BTW_EVENT_CHANNEL = "btw:event"`; types `BtwThreadMode`, `BtwModelRef`, `BtwThinkingLevel`, `BtwCommand`, `BtwMessageStatus`, `BtwMessageSnapshot`, `BtwThreadState`, `BtwEvent`; guard `isBtwCommand(data: unknown): data is BtwCommand`. Every later btw task imports from here; the webui package redeclares the same shapes locally (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/webui-events.test.ts
import { describe, expect, it } from "bun:test";
import {
  BTW_COMMAND_CHANNEL,
  BTW_EVENT_CHANNEL,
  isBtwCommand,
  type BtwCommand,
  type BtwEvent,
} from "../src/btw/webui-events";

describe("btw webui-events channel contract", () => {
  it("exports the agreed channel names", () => {
    expect(BTW_COMMAND_CHANNEL).toBe("webui:btw-command");
    expect(BTW_EVENT_CHANNEL).toBe("btw:event");
  });

  it("command payloads are JSON-safe", () => {
    const commands: BtwCommand[] = [
      { kind: "ask", text: "why did the render fail?" },
      { kind: "new" },
      { kind: "clear" },
      { kind: "inject" },
      { kind: "summarize" },
      { kind: "model", model: { provider: "anthropic", id: "claude-sonnet-4", api: "anthropic" } },
      { kind: "model", model: null },
      { kind: "thinking", level: "off" },
      { kind: "thinking", level: null },
      { kind: "mode", mode: "tangent" },
    ];
    for (const command of commands) {
      expect(() => JSON.stringify(command)).not.toThrow();
      expect(JSON.parse(JSON.stringify(command))).toEqual(command);
    }
  });

  it("event payloads are JSON-safe", () => {
    const events: BtwEvent[] = [
      {
        type: "thread",
        state: {
          messages: [
            { id: "btw-m-0", role: "user", text: "q", status: "done" },
            {
              id: "btw-m-1",
              role: "assistant",
              text: "a",
              status: "running-tool",
              statusText: "running-tool: bash",
            },
          ],
          mode: "contextual",
          model: null,
          thinking: null,
        },
      },
      { type: "notice", text: "Injected into the main session" },
    ];
    for (const event of events) {
      expect(() => JSON.stringify(event)).not.toThrow();
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  it("isBtwCommand accepts known kinds and rejects garbage", () => {
    expect(isBtwCommand({ kind: "ask", text: "hi" })).toBe(true);
    expect(isBtwCommand({ kind: "mode", mode: "tangent" })).toBe(true);
    expect(isBtwCommand({ kind: "bogus" })).toBe(false);
    expect(isBtwCommand(null)).toBe(false);
    expect(isBtwCommand("ask")).toBe(false);
    expect(isBtwCommand({ kind: "ask" })).toBe(false); // missing text
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-events.test.ts )`
Expected: FAIL — cannot resolve `../src/btw/webui-events`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts
/**
 * Event-bus seam between pi-agent-ext-btw and pi-agent-ext-webui.
 *
 * Plain string channels (SDK EventBus convention: on() returns an unsubscribe
 * disposer, there is no off()). Payloads are JSON-safe. The webui package
 * redeclares these constants and shapes locally in its own src/btw-channels.ts
 * — there is deliberately NO package dependency webui -> btw; the string
 * values are the contract (pinned by the cross-package contract test).
 */

export const BTW_COMMAND_CHANNEL = "webui:btw-command" as const;
export const BTW_EVENT_CHANNEL = "btw:event" as const;

export type BtwThreadMode = "contextual" | "tangent";

/** Registry model reference; field names mirror the btw model-override entry payload. */
export interface BtwModelRef {
  provider: string;
  id: string;
  api: string;
}

/** Thinking override level; keep in sync with the SDK SessionThinkingLevel used by btw. */
export type BtwThinkingLevel = "off" | "low" | "medium" | "high";

export type BtwCommand =
  | { kind: "ask"; text: string }
  | { kind: "new" }
  | { kind: "clear" }
  | { kind: "inject" }
  | { kind: "summarize" }
  | { kind: "model"; model: BtwModelRef | null }
  | { kind: "thinking"; level: BtwThinkingLevel | null }
  | { kind: "mode"; mode: BtwThreadMode };

export type BtwMessageStatus = "streaming" | "running-tool" | "done" | "error";

export interface BtwMessageSnapshot {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: BtwMessageStatus;
  statusText?: string;
}

export interface BtwThreadState {
  messages: BtwMessageSnapshot[];
  mode: BtwThreadMode;
  model: BtwModelRef | null;
  thinking: BtwThinkingLevel | null;
}

export type BtwEvent =
  | { type: "thread"; state: BtwThreadState }
  | { type: "notice"; text: string };

const KINDS: ReadonlySet<string> = new Set([
  "ask",
  "new",
  "clear",
  "inject",
  "summarize",
  "model",
  "thinking",
  "mode",
]);

/** Narrow an unknown event-bus payload to a BtwCommand; unknown data is ignored. */
export function isBtwCommand(data: unknown): data is BtwCommand {
  if (!data || typeof data !== "object") return false;
  const command = data as Record<string, unknown>;
  if (typeof command.kind !== "string" || !KINDS.has(command.kind)) return false;
  switch (command.kind) {
    case "ask":
      return typeof command.text === "string";
    case "mode":
      return command.mode === "contextual" || command.mode === "tangent";
    default:
      return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-events.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts bun-apps/pi-agent-ext-btw/__tests__/webui-events.test.ts
git commit -m "feat(btw): add webui event-bus channel constants and payload types"
```

### Task 2: snapshot derivation module

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts`
- Test: `bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: `BtwDetails` from `src/btw/types.ts` (existing: `{ question; thinking; answer; provider; model; api; thinkingLevel; timestamp; usage? }`); `AgentSessionEvent` type (import from the same SDK module path `src/btw/session.ts` uses — adjust the import specifier if it differs); `BtwMessageSnapshot` from Task 1.
- Produces: `interface BtwStatusUpdate { status: BtwMessageStatus; statusText?: string }`; `snapshotsFromDetails(details: BtwDetails[]): BtwMessageSnapshot[]`; `statusFromEvent(event: AgentSessionEvent): BtwStatusUpdate | null`; `snapshotsFromMessages(messages: AgentMessage[], status: BtwStatusUpdate | null): BtwMessageSnapshot[]`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts
import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "../src/btw/types";
import { snapshotsFromDetails, snapshotsFromMessages, statusFromEvent } from "../src/btw/snapshot";

const ev = (partial: Record<string, unknown>): AgentSessionEvent =>
  partial as unknown as AgentSessionEvent;

const details: BtwDetails[] = [
  {
    question: "what failed?",
    thinking: "",
    answer: "the shader compile step",
    provider: "anthropic",
    model: "claude-sonnet-4",
    api: "anthropic",
    thinkingLevel: "off",
    timestamp: 1,
  },
];

describe("snapshotsFromDetails", () => {
  it("maps persisted BtwDetails to stable keyed snapshots", () => {
    expect(snapshotsFromDetails(details)).toEqual([
      { id: "btw-d-0", role: "user", text: "what failed?", status: "done" },
      { id: "btw-d-1", role: "assistant", text: "the shader compile step", status: "done" },
    ]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(snapshotsFromDetails([])).toEqual([]);
  });
});

describe("statusFromEvent", () => {
  it("maps tool lifecycle events to running-tool status", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_start", toolName: "bash" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(statusFromEvent(ev({ type: "tool_execution_start" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: tool",
    });
  });

  it("maps turn lifecycle back to streaming/done", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_end" }))).toEqual({ status: "streaming" });
    expect(statusFromEvent(ev({ type: "turn_end" }))).toEqual({ status: "done" });
  });

  it("returns null for events that do not change status", () => {
    expect(statusFromEvent(ev({ type: "message_update" }))).toBeNull();
    expect(statusFromEvent(ev({ type: "turn_start" }))).toBeNull();
  });
});

describe("snapshotsFromMessages", () => {
  it("derives keyed snapshots, folding the status override into the last message", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "partial answer" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(
      snapshotsFromMessages(messages, { status: "running-tool", statusText: "running-tool: bash" }),
    ).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      {
        id: "btw-m-1",
        role: "assistant",
        text: "partial answer",
        status: "running-tool",
        statusText: "running-tool: bash",
      },
    ]);
  });

  it("defaults the last live message to streaming when no override is set", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "a" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(snapshotsFromMessages(messages, null)).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      { id: "btw-m-1", role: "assistant", text: "a", status: "streaming" },
    ]);
  });
});
```

Note for the implementer: the fixture message shape above (`role` + `parts[].text`) is the plan's best-grounded guess. Before writing the implementation, check the real `AgentMessage` shape via the extraction already in `src/btw/session.ts` (`runBtw`'s answer extraction and `getBtwHandoffThread`'s live-message walk) and adjust BOTH `textOf`/`roleOf` below and these fixtures together so the assertions stay exactly these.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/snapshot.test.ts )`
Expected: FAIL — cannot resolve `../src/btw/snapshot`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "./types";
import type { BtwMessageSnapshot, BtwMessageStatus } from "./webui-events";

/** A status change derived from a sub-session AgentSessionEvent; null = no change. */
export interface BtwStatusUpdate {
  status: BtwMessageStatus;
  statusText?: string;
}

/** Persisted thread (BtwDetails[]) -> snapshots. Ids are index-stable: btw-d-<index>. */
export function snapshotsFromDetails(details: BtwDetails[]): BtwMessageSnapshot[] {
  const snapshots: BtwMessageSnapshot[] = [];
  for (const entry of details) {
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "user", text: entry.question, status: "done" });
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "assistant", text: entry.answer, status: "done" });
  }
  return snapshots;
}

/**
 * Map a sub-session event to a status override for the LAST live message.
 * Reads only the event type discriminant plus an optional tool name — never
 * full event payloads — so it stays robust across SDK event shapes.
 */
export function statusFromEvent(event: AgentSessionEvent): BtwStatusUpdate | null {
  const type = (event as { type?: unknown }).type;
  if (type === "tool_execution_start") {
    const toolName = (event as { toolName?: unknown }).toolName;
    return { status: "running-tool", statusText: `running-tool: ${typeof toolName === "string" && toolName ? toolName : "tool"}` };
  }
  if (type === "tool_execution_end") return { status: "streaming" };
  if (type === "turn_end") return { status: "done" };
  return null;
}

// roleOf/textOf mirror the extraction already used by src/btw/session.ts
// (runBtw's answer extraction / getBtwHandoffThread's live-message walk).
// If session.ts exports a reusable helper, import it instead of duplicating.
function roleOf(message: unknown): "user" | "assistant" {
  const role = (message as { role?: unknown }).role;
  return role === "user" ? "user" : "assistant";
}

function textOf(message: unknown): string {
  const parts = (message as { parts?: Array<{ type?: unknown; text?: unknown }> }).parts ?? [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Live sub-session messages -> snapshots. Ids are index-stable: btw-m-<index>.
 * The status override (if any) is folded into the LAST message only; with no
 * override the last message defaults to "streaming" (mid-turn).
 */
export function snapshotsFromMessages(
  messages: readonly unknown[],
  status: BtwStatusUpdate | null,
): BtwMessageSnapshot[] {
  return messages.map((message, index) => {
    const isLast = index === messages.length - 1;
    const update = isLast ? (status ?? { status: "streaming" as const }) : null;
    return {
      id: `btw-m-${index}`,
      role: roleOf(message),
      text: textOf(message),
      status: update ? update.status : "done",
      ...(update?.statusText ? { statusText: update.statusText } : {}),
    };
  });
}
```

If the real `AgentMessage` type is available as an export, type `messages: readonly AgentMessage[]` and drop the `unknown` casting — keep the runtime behavior identical either way.

Note: real code (`src/btw/session.ts` `handleBtwSessionEvent`) maps `tool_execution_end` back to "streaming" only when the session is still streaming (`session.isStreaming`); `statusFromEvent` maps it unconditionally. This simplification is deliberate — `statusFromEvent` has no session handle, and the unconditional mapping only differs in the brief post-tool window.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/snapshot.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts
git commit -m "feat(btw): add snapshot derivation for webui thread events"
```

### Task 3: recording fake-pi helper + engine webui bridge (emit thread events)

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts`
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/session.ts` (additive fields + methods; hook into `createBtwSubSession` and `disposeBtwSession`)
- Test: `bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BTW_EVENT_CHANNEL`, `BtwEvent`, `BtwThreadState`, `BtwModelRef`), Task 2 (`snapshotsFromDetails`, `snapshotsFromMessages`, `statusFromEvent`, `BtwStatusUpdate`); existing engine surface (`BtwEngine(pi)`, public `pendingThread`, `pendingMode`, `btwModelOverride`, `btwThinkingOverride`, `activeBtwSession: BtwSessionRuntime | null`, `BtwSessionRuntime = { session; mode; subscriptions: Set<()=>void>; sideThreadStartIndex }`).
- Produces: `makeFakeBusPi(): FakePi` (test helper: `{ pi: ExtensionAPI; emitted; appendEntries; trigger(event, ...args) }`); engine methods `setLatestCtx(ctx: ExtensionCommandContext): void`, `subscribeWebuiBridge(sr: BtwSessionRuntime): void`, `emitThreadEvent(): void`, `emitNotice(text: string): void`, `buildThreadState(): BtwThreadState`, `handleWebuiCommand(command: BtwCommand): Promise<void>` (handleWebuiCommand lands in Task 4 but its emit helpers come from here).

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts
import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { BtwEngine } from "../src/btw/session";

function makeFakeSession(messages: unknown[] = []) {
  let listener: ((event: unknown) => void) | null = null;
  return {
    agent: { state: { messages } },
    subscribe(cb: (event: unknown) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    push(event: unknown) {
      listener?.(event);
    },
    abort() {},
    async dispose() {},
  };
}

const MESSAGES = [
  { role: "user", parts: [{ type: "text", text: "q" }] },
  { role: "assistant", parts: [{ type: "text", text: "partial" }] },
];

describe("BtwEngine webui bridge", () => {
  it("emits thread events with pre-reduced snapshots on every sub-session event", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession(MESSAGES);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.subscribeWebuiBridge(engine.activeBtwSession);

    fake.push({ type: "message_update" });
    let last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", role: "user", text: "q", status: "done" },
          { id: "btw-m-1", role: "assistant", text: "partial", status: "streaming" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });

    fake.push({ type: "tool_execution_start", toolName: "bash" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", status: "done" },
          { id: "btw-m-1", status: "running-tool", statusText: "running-tool: bash" },
        ],
      },
    });

    fake.push({ type: "turn_end" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: { messages: [{ id: "btw-m-1", status: "done" }] },
    });
  });

  it("falls back to pendingThread snapshots after the session is disposed", async () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession([]);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.pendingThread.push({
      question: "persisted q",
      thinking: "",
      answer: "persisted a",
      provider: "anthropic",
      model: "claude-sonnet-4",
      api: "anthropic",
      thinkingLevel: "off",
      timestamp: 1,
    });
    await engine.disposeBtwSession();
    engine.emitThreadEvent();
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-d-0", role: "user", text: "persisted q", status: "done" },
          { id: "btw-d-1", role: "assistant", text: "persisted a", status: "done" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });
  });

  it("emitNotice posts a notice event on the event channel", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    engine.emitNotice("Injected into the main session");
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "notice",
      text: "Injected into the main session",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-bridge.test.ts )`
Expected: FAIL — `makeFakeBusPi` unresolved; `subscribeWebuiBridge` / `emitThreadEvent` / `emitNotice` not defined on `BtwEngine`.

- [ ] **Step 3: Write the fake-pi helper**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FakePi {
  pi: ExtensionAPI;
  emitted: { channel: string; data: unknown }[];
  appendEntries: { type: string; payload: unknown }[];
  trigger(event: string, ...args: unknown[]): void;
}

type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Recording fake ExtensionAPI for webui-seam tests: an in-memory EventBus
 * (emit fans out to on-handlers and records every emission) plus a recording
 * appendEntry and on-handler registry. Extend the stub object with any extra
 * no-op methods the code under test touches — mirror the mock style of
 * __tests__/registration.test.ts (makeRecorderPi) / extension-contract.test.ts.
 */
export function makeFakeBusPi(): FakePi {
  const emitted: FakePi["emitted"] = [];
  const appendEntries: FakePi["appendEntries"] = [];
  const handlers = new Map<string, Set<AnyHandler>>();

  const pi = {
    events: {
      emit(channel: string, data: unknown): void {
        emitted.push({ channel, data });
        handlers.get(channel)?.forEach((handler) => handler(data));
      },
      on(channel: string, handler: AnyHandler): () => void {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
    },
    appendEntry(type: string, payload: unknown): void {
      appendEntries.push({ type, payload });
    },
    on(event: string, handler: AnyHandler): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    registerCommand(): void {},
    registerShortcut(): void {},
    registerMessageRenderer(): void {},
    sendUserMessage(): void {},
    ui: {},
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    emitted,
    appendEntries,
    trigger(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
  };
}
```

- [ ] **Step 4: Implement the engine bridge (additive only)**

Add imports at the top of `bun-apps/pi-agent-ext-btw/src/btw/session.ts`:

```ts
import {
  BTW_EVENT_CHANNEL,
  type BtwCommand,
  type BtwEvent,
  type BtwThreadState,
} from "./webui-events";
import {
  snapshotsFromDetails,
  snapshotsFromMessages,
  statusFromEvent,
  type BtwStatusUpdate,
} from "./snapshot";
```

Add these fields next to the existing private state of `BtwEngine`:

```ts
/** Latest ExtensionCommandContext seen at session_start/session_tree; the webui command channel carries no ctx. */
private latestCtx: ExtensionCommandContext | null = null;
/** Status override for the last live message, derived from sub-session events. */
private webuiStatus: BtwStatusUpdate | null = null;
/** The BtwSessionRuntime currently bridged to the webui event channel. */
private webuiBridgedFor: BtwSessionRuntime | null = null;
```

Add these methods to `BtwEngine` (do NOT touch `subscribeOverlayToActiveBtwSession`, `handleBtwSessionEvent`, or anything else on the TUI path):

```ts
/** Record the ctx the webui command handler should use (set from session_start/session_tree). */
setLatestCtx(ctx: ExtensionCommandContext): void {
  this.latestCtx = ctx;
}

/**
 * Webui bridge: an ADDITIONAL session subscription (separate from the overlay's)
 * that pre-reduces each sub-session event into a thread snapshot and emits it on
 * BTW_EVENT_CHANNEL. Never touches applyTranscriptEvent / setOverlayStatus / syncUi.
 */
subscribeWebuiBridge(sr: BtwSessionRuntime): void {
  if (this.webuiBridgedFor === sr) return;
  this.webuiBridgedFor = sr;
  this.webuiStatus = null;
  const dispose = sr.session.subscribe((event: AgentSessionEvent) => {
    const update = statusFromEvent(event);
    if (update) this.webuiStatus = update;
    this.emitThreadEvent();
  });
  sr.subscriptions.add(() => {
    if (this.webuiBridgedFor === sr) this.webuiBridgedFor = null;
    dispose();
  });
}

/** Current thread state, pre-reduced for the webui panel (D5). */
buildThreadState(): BtwThreadState {
  const messages = this.activeBtwSession
    ? snapshotsFromMessages(
        this.activeBtwSession.session.agent.state.messages.slice(
          this.activeBtwSession.sideThreadStartIndex,
        ),
        this.webuiStatus,
      )
    : snapshotsFromDetails(this.pendingThread);
  return {
    messages,
    mode: this.pendingMode,
    model: this.btwModelOverride
      ? {
          provider: this.btwModelOverride.provider,
          id: this.btwModelOverride.id,
          api: this.btwModelOverride.api,
        }
      : null,
    thinking: this.btwThinkingOverride,
  };
}

/** Emit the current thread snapshot on the webui event channel. */
emitThreadEvent(): void {
  const event: BtwEvent = { type: "thread", state: this.buildThreadState() };
  this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
}

/** Emit a one-line notice (inject confirmation, summarize output, errors). */
emitNotice(text: string): void {
  const event: BtwEvent = { type: "notice", text };
  this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
}
```

Two small edits inside existing methods (additive lines only):

- In `createBtwSubSession(ctx)`, as the last statement before returning the runtime: `this.subscribeWebuiBridge(sr);` (adjust to the local variable name the method actually uses for the `BtwSessionRuntime` it builds).
- In `disposeBtwSession()`, add `this.webuiStatus = null;` next to wherever the active session is cleared, and after the clearing add `this.emitThreadEvent();` so the panel falls back to the persisted thread.

Note (soft spot): the `btwModelOverride` mapping reads `provider`/`id`/`api` off `SessionModel` — mirror the field access used when the override entry payload is built in `setBtwModelOverride` and adjust the three keys there if the SDK `Model` names differ.

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-bridge.test.ts )`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full btw gate (TUI regression check)**

Run: `( cd bun-apps/pi-agent-ext-btw && bun run test )`
Expected: PASS — all pre-existing tests (registration, extension-contract, markdown-render) stay green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts bun-apps/pi-agent-ext-btw/src/btw/session.ts
git commit -m "feat(btw): emit pre-reduced thread snapshots on the webui event channel"
```

### Task 4: command-channel subscription + ctx capture in registerBtwFeature

**Files:**
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/session.ts` (add `handleWebuiCommand`)
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/index.ts` (capture ctx, emit initial thread event, subscribe to the command channel)
- Test: `bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BTW_COMMAND_CHANNEL`, `isBtwCommand`, `BtwCommand`); Task 3 (`setLatestCtx`, `emitThreadEvent`, `emitNotice`, `latestCtx`); existing engine surface (`dispatchBtwCommand(name, args, ctx)`, `runBtw(ctx, question, saveRequested=false)`, `getBtwHandoffThread(ctx)`, `summarizeThread(ctx, thread)`, `setBtwModelOverride(ctx, model)`, `setBtwThinkingOverride(ctx, level)`, `disposeBtwSession()`, `pendingMode`).
- Produces: `BtwEngine.handleWebuiCommand(command: BtwCommand): Promise<void>`; `registerBtwFeature` now (a) calls `engine.setLatestCtx(ctx)` + `engine.emitThreadEvent()` in its `session_start`/`session_tree` handlers, and (b) subscribes `pi.events.on(BTW_COMMAND_CHANNEL, ...)` dispatching into `handleWebuiCommand`. No new tools, no new commands registered (D2).

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts
import { describe, expect, it } from "bun:test";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { registerBtwFeature } from "../src/btw";
import { BTW_COMMAND_CHANNEL } from "../src/btw/webui-events";

const fakeCtx = {
  isIdle: () => true,
  sessionManager: { getBranch: () => [] },
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
} as unknown as Parameters<Parameters<typeof registerBtwFeature>[0]["on"]>[1];

const threadEvents = (emitted: { channel: string; data: unknown }[]) =>
  emitted.filter((e) => e.channel === "btw:event" && (e.data as { type?: string }).type === "thread");

describe("webui command channel", () => {
  it("ignores commands before any session_start (no ctx yet)", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    const last = fake.emitted.filter((e) => e.channel === "btw:event").at(-1)?.data as
      | { type?: string; text?: string }
      | undefined;
    expect(last?.type).toBe("notice");
    expect(String(last?.text)).toContain("no active session");
  });

  it("dispatches clear through the engine (persisted reset entry) and emits a thread event", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    expect(fake.appendEntries.map((e) => e.type)).toContain("btw-thread-reset");
    expect(threadEvents(fake.emitted).length).toBeGreaterThan(0);
  });

  it("mode command switches pendingMode, disposes the session, and reports it", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "mode", mode: "tangent" });
    const last = threadEvents(fake.emitted).at(-1)?.data as { state?: { mode?: string } };
    expect(last?.state?.mode).toBe("tangent");
  });

  it("ignores malformed payloads instead of throwing", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "bogus" })).not.toThrow();
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, null)).not.toThrow();
  });

  it("emits an initial thread event at session_start (seeds the webui store)", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    expect(threadEvents(fake.emitted).length).toBeGreaterThanOrEqual(1);
  });
});
```

Note: `fakeCtx`'s cast keeps the test model-free; add further no-op members only if `restoreThread`/`dispatchBtwCommand` actually dereference them (mirror `__tests__/extension-contract.test.ts`'s mock ctx if one exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-command.test.ts )`
Expected: FAIL — no subscription on `webui:btw-command`, no initial thread event at `session_start`.

- [ ] **Step 3: Implement handleWebuiCommand on BtwEngine**

Add to `BtwEngine` in `bun-apps/pi-agent-ext-btw/src/btw/session.ts`:

```ts
/**
 * Handle a webui panel command. ask/new/clear/inject/summarize reuse the exact
 * TUI code paths (runBtw / dispatchBtwCommand); model/thinking/mode use the
 * engine setters directly. Always ends with a thread event (or a notice on error).
 */
async handleWebuiCommand(command: BtwCommand): Promise<void> {
  const ctx = this.latestCtx;
  if (!ctx) {
    this.emitNotice("btw: no active session context yet");
    return;
  }
  try {
    switch (command.kind) {
      case "ask":
        await this.runBtw(ctx, command.text, false);
        break;
      case "new":
        await this.dispatchBtwCommand("btw:new", "", ctx);
        break;
      case "clear":
        await this.dispatchBtwCommand("btw:clear", "", ctx);
        break;
      case "inject":
        await this.dispatchBtwCommand("btw:inject", "", ctx);
        this.emitNotice("Injected into the main session");
        break;
      case "summarize": {
        const { thread } = await this.getBtwHandoffThread(ctx);
        const summary = await this.summarizeThread(ctx, thread);
        this.emitNotice(summary);
        break;
      }
      case "model": {
        const model = command.model
          ? (ctx.modelRegistry.find(command.model.provider, command.model.id) ?? null)
          : null;
        await this.setBtwModelOverride(ctx, model);
        break;
      }
      case "thinking":
        await this.setBtwThinkingOverride(ctx, command.level);
        break;
      case "mode":
        // Mirror the engine's dispose-on-mode-change semantics: next ensureBtwSession
        // rebuilds in the new mode; dispose now so the panel reflects the reset.
        this.pendingMode = command.mode;
        await this.disposeBtwSession();
        break;
    }
  } catch (error) {
    this.emitNotice(`btw: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  this.emitThreadEvent();
}
```

- [ ] **Step 4: Wire the subscription + ctx capture in registerBtwFeature**

In `bun-apps/pi-agent-ext-btw/src/btw/index.ts`, inside `registerBtwFeature(pi)`:

1. Add the import: `import { BTW_COMMAND_CHANNEL, isBtwCommand } from "./webui-events";`
2. In the existing `session_start` and `session_tree` handlers (keep all surrounding code as-is; these are the added lines):

```ts
pi.on("session_start", async (_event, ctx) => {
  engine.setLatestCtx(ctx);
  // ... existing restoreThread call stays ...
  await engine.restoreThread(ctx);
  engine.emitThreadEvent();
});
// session_tree handler gets the identical three additions.
```

3. Register the command-channel subscription next to the existing `pi.on("context")` filter:

```ts
// webui panel commands (user-only surface; D2 — no new tools registered)
pi.events?.on(BTW_COMMAND_CHANNEL, (data: unknown) => {
  if (!isBtwCommand(data)) return;
  void engine.handleWebuiCommand(data);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-command.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full btw gate (TUI regression check)**

Run: `( cd bun-apps/pi-agent-ext-btw && bun run test )`
Expected: PASS — registration.test.ts (4), extension-contract.test.ts (3), markdown-render.test.ts (4) all green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/src/btw/session.ts bun-apps/pi-agent-ext-btw/src/btw/index.ts bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts
git commit -m "feat(btw): subscribe to webui command channel with ctx capture"
```


## Phase 2 — webui transports

### Task 5: webui local channel redeclaration + bus helpers

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-channels.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts`

**Interfaces:**
- Consumes: nothing from the btw package (that is the point — this is a deliberate LOCAL redeclaration of the shapes documented in Phase context; the string values are pinned by Task 11's contract test).
- Produces: `BTW_COMMAND_CHANNEL`, `BTW_EVENT_CHANNEL` (same values as btw's); payload types `BtwThreadMode`, `BtwModelRef`, `BtwThinkingLevel`, `BtwCommand`, `BtwMessageStatus`, `BtwMessageSnapshot`, `BtwThreadState`, `BtwEvent`; `isBtwEvent(data): data is BtwEvent`; `btwCommandFromFrame(frame: BtwCommandFrameInput): BtwCommand | null`; `emitBtwCommand(bus: { emit(channel, data) }, command: BtwCommand): void`; `onBtwEvent(bus: { on(channel, handler) }, handler: (event: BtwEvent) => void): () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts
import { describe, expect, it } from "bun:test";
import {
  BTW_COMMAND_CHANNEL,
  BTW_EVENT_CHANNEL,
  btwCommandFromFrame,
  emitBtwCommand,
  isBtwEvent,
  onBtwEvent,
} from "../src/btw-channels";

function fakeBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.forEach((handler) => handler(data));
    },
  };
}

describe("btw-channels seam", () => {
  it("declares the agreed channel names", () => {
    expect(BTW_COMMAND_CHANNEL).toBe("webui:btw-command");
    expect(BTW_EVENT_CHANNEL).toBe("btw:event");
  });

  it("isBtwEvent accepts thread and notice payloads, rejects garbage", () => {
    expect(isBtwEvent({ type: "thread", state: { messages: [], mode: "contextual", model: null, thinking: null } })).toBe(true);
    expect(isBtwEvent({ type: "notice", text: "hi" })).toBe(true);
    expect(isBtwEvent({ type: "thread" })).toBe(false);
    expect(isBtwEvent({ type: "other" })).toBe(false);
    expect(isBtwEvent(null)).toBe(false);
  });

  it("btwCommandFromFrame maps validated frames to commands", () => {
    expect(btwCommandFromFrame({ kind: "ask", text: "hi" })).toEqual({ kind: "ask", text: "hi" });
    expect(btwCommandFromFrame({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(btwCommandFromFrame({ kind: "mode", mode: "tangent" })).toEqual({ kind: "mode", mode: "tangent" });
    expect(btwCommandFromFrame({ kind: "model", model: { provider: "p", id: "m", api: "a" } })).toEqual({
      kind: "model",
      model: { provider: "p", id: "m", api: "a" },
    });
    expect(btwCommandFromFrame({ kind: "thinking", level: null })).toEqual({ kind: "thinking", level: null });
  });

  it("btwCommandFromFrame rejects invalid frames with null", () => {
    expect(btwCommandFromFrame({ kind: "ask" })).toBeNull(); // missing text
    expect(btwCommandFromFrame({ kind: "mode", mode: "bogus" })).toBeNull();
    expect(btwCommandFromFrame({ kind: "bogus" })).toBeNull();
  });

  it("emitBtwCommand / onBtwEvent round-trip over a fake bus", () => {
    const bus = fakeBus();
    const received: unknown[] = [];
    const seenEvents: unknown[] = [];
    const dispose = onBtwEvent(bus, (event) => seenEvents.push(event));
    bus.on(BTW_COMMAND_CHANNEL, (data) => received.push(data));

    emitBtwCommand(bus, { kind: "summarize" });
    expect(received).toEqual([{ kind: "summarize" }]);

    bus.emit("btw:event", { type: "notice", text: "ok" });
    expect(seenEvents).toEqual([{ type: "notice", text: "ok" }]);

    bus.emit("btw:event", { type: "garbage" });
    expect(seenEvents).toHaveLength(1); // guard dropped it

    dispose();
    bus.emit("btw:event", { type: "notice", text: "after dispose" });
    expect(seenEvents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-channels.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-channels`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-webui/src/btw-channels.ts
/**
 * LOCAL redeclaration of the btw <-> webui event-bus seam.
 *
 * Mirrors bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts WITHOUT importing
 * it: there is deliberately NO package dependency webui -> btw. The string
 * channel values are the contract; tests/btw-contract.test.ts pins them.
 */

export const BTW_COMMAND_CHANNEL = "webui:btw-command" as const;
export const BTW_EVENT_CHANNEL = "btw:event" as const;

export type BtwThreadMode = "contextual" | "tangent";

export interface BtwModelRef {
  provider: string;
  id: string;
  api: string;
}

export type BtwThinkingLevel = "off" | "low" | "medium" | "high";

export type BtwCommand =
  | { kind: "ask"; text: string }
  | { kind: "new" }
  | { kind: "clear" }
  | { kind: "inject" }
  | { kind: "summarize" }
  | { kind: "model"; model: BtwModelRef | null }
  | { kind: "thinking"; level: BtwThinkingLevel | null }
  | { kind: "mode"; mode: BtwThreadMode };

export type BtwMessageStatus = "streaming" | "running-tool" | "done" | "error";

export interface BtwMessageSnapshot {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: BtwMessageStatus;
  statusText?: string;
}

export interface BtwThreadState {
  messages: BtwMessageSnapshot[];
  mode: BtwThreadMode;
  model: BtwModelRef | null;
  thinking: BtwThinkingLevel | null;
}

export type BtwEvent =
  | { type: "thread"; state: BtwThreadState }
  | { type: "notice"; text: string };

/** Narrow an unknown event-bus payload to a BtwEvent; unknown data is dropped. */
export function isBtwEvent(data: unknown): data is BtwEvent {
  if (!data || typeof data !== "object") return false;
  const event = data as { type?: unknown; state?: unknown; text?: unknown };
  if (event.type === "notice") return typeof event.text === "string";
  if (event.type === "thread") return !!event.state && typeof event.state === "object";
  return false;
}

/** Input shape of a validated inbound `btw` WS frame minus the `type` literal. */
export interface BtwCommandFrameInput {
  kind: string;
  text?: string;
  mode?: string;
  model?: BtwModelRef | null;
  level?: BtwThinkingLevel | null;
}

/** Map a validated frame body to a BtwCommand; null when the body is inconsistent. */
export function btwCommandFromFrame(frame: BtwCommandFrameInput): BtwCommand | null {
  switch (frame.kind) {
    case "ask":
      return typeof frame.text === "string" && frame.text.length > 0 ? { kind: "ask", text: frame.text } : null;
    case "new":
    case "clear":
    case "inject":
    case "summarize":
      return { kind: frame.kind };
    case "model":
      return { kind: "model", model: frame.model ?? null };
    case "thinking":
      return { kind: "thinking", level: frame.level ?? null };
    case "mode":
      return frame.mode === "contextual" || frame.mode === "tangent"
        ? { kind: "mode", mode: frame.mode }
        : null;
    default:
      return null;
  }
}

/** Emit a panel command on the command channel (webui -> btw direction). */
export function emitBtwCommand(
  bus: { emit(channel: string, data: unknown): void },
  command: BtwCommand,
): void {
  bus.emit(BTW_COMMAND_CHANNEL, command);
}

/** Subscribe to thread events (btw -> webui direction); returns disposer. */
export function onBtwEvent(
  bus: { on(channel: string, handler: (data: unknown) => void): () => void },
  handler: (event: BtwEvent) => void,
): () => void {
  return bus.on(BTW_EVENT_CHANNEL, (data) => {
    if (isBtwEvent(data)) handler(data);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-channels.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-channels.ts bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts
git commit -m "feat(webui): add local btw channel seam redeclaration and bus helpers"
```

### Task 6: protocol frame + transport mapping

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/protocol.ts` (add `BtwCommandFrameSchema` to the inbound union; add `BtwWebFrame` to the outbound `WebFrame` union)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-transport.ts` (new `parseCommand` case + `DispatchAction` member)
- Test: `bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts` (or extend the existing protocol/transport test files with these cases — follow wherever `appexec` frame tests live)

**Interfaces:**
- Consumes: Task 5 (`btwCommandFromFrame`, `BtwCommand`, `BtwEvent`); existing `validateInbound(raw): ClientFrame | null`, `WebTransport.parseCommand(frame): DispatchAction | ...`, TypeBox `Type`/`Static`.
- Produces: `BtwCommandFrameSchema` / `BtwCommandFrame` (validated inbound frame `{ type: "btw"; kind; text?; mode?; model?; level? }`); `BtwWebFrame = { type: "btw"; event: BtwEvent }` member of `WebFrame`; `DispatchAction` member `{ kind: "btw"; command: BtwCommand }`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts
import { describe, expect, it } from "bun:test";
import { validateInbound } from "../src/protocol";
import { WebTransport } from "../src/web-transport";

describe("btw inbound frames", () => {
  it("validates well-formed btw command frames", () => {
    expect(validateInbound({ type: "btw", kind: "ask", text: "hi" })).toEqual({
      type: "btw",
      kind: "ask",
      text: "hi",
    });
    expect(validateInbound({ type: "btw", kind: "mode", mode: "tangent" })).toEqual({
      type: "btw",
      kind: "mode",
      mode: "tangent",
    });
    expect(validateInbound({ type: "btw", kind: "model", model: { provider: "p", id: "m", api: "a" } })).toEqual({
      type: "btw",
      kind: "model",
      model: { provider: "p", id: "m", api: "a" },
    });
  });

  it("rejects frames with an unknown kind", () => {
    expect(validateInbound({ type: "btw", kind: "bogus" })).toBeNull();
    expect(validateInbound({ type: "btw" })).toBeNull();
  });

  it("parseCommand maps btw frames to a btw dispatch action", () => {
    expect(WebTransport.parseCommand({ type: "btw", kind: "mode", mode: "tangent" } as never)).toEqual({
      kind: "btw",
      command: { kind: "mode", mode: "tangent" },
    });
    expect(WebTransport.parseCommand({ type: "btw", kind: "summarize" } as never)).toEqual({
      kind: "btw",
      command: { kind: "summarize" },
    });
  });

  it("parseCommand returns null for inconsistent btw bodies", () => {
    expect(WebTransport.parseCommand({ type: "btw", kind: "ask" } as never)).toBeNull();
    expect(WebTransport.parseCommand({ type: "btw", kind: "mode", mode: "bogus" } as never)).toBeNull();
  });
});
```

If the existing transport tests already cover `parseCommand` for `appexec` in a dedicated file, add these cases there instead of a new file — keep the imports identical to that file's.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol-btw.test.ts )`
Expected: FAIL — `BtwCommandFrameSchema` not in the union (`validateInbound` returns null) and `parseCommand` has no `btw` case.

- [ ] **Step 3: Implement protocol additions**

In `bun-apps/pi-agent-ext-webui/src/protocol.ts` (TypeBox — NOT zod):

```ts
import { btwCommandFromFrame, type BtwEvent } from "./btw-channels";
// (merge into the existing imports at the top of the file)

export const BtwCommandFrameSchema = Type.Object({
  type: Type.Literal("btw"),
  kind: Type.Union([
    Type.Literal("ask"),
    Type.Literal("new"),
    Type.Literal("clear"),
    Type.Literal("inject"),
    Type.Literal("summarize"),
    Type.Literal("model"),
    Type.Literal("thinking"),
    Type.Literal("mode"),
  ]),
  text: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("contextual"), Type.Literal("tangent")])),
  model: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({ provider: Type.String(), id: Type.String(), api: Type.String() }),
    ]),
  ),
  level: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Union([
        Type.Literal("off"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    ]),
  ),
});
export type BtwCommandFrame = Static<typeof BtwCommandFrameSchema>;
```

Add `BtwCommandFrameSchema` to the `InboundCommandSchema` union (alongside `AgenticWithTextSchema`, `AbortCommandSchema`, `AppExecCommandSchema`, `ControlCommandSchema`). Add the explicit outbound member to the `WebFrame` union:

```ts
export interface BtwWebFrame {
  type: "btw";
  event: BtwEvent;
}
```

- [ ] **Step 4: Implement the transport mapping**

In `bun-apps/pi-agent-ext-webui/src/web-transport.ts`:

1. Extend the `DispatchAction` union with `{ kind: "btw"; command: BtwCommand }` (import `BtwCommand` from `./btw-channels`).
2. In `parseCommand`, next to the existing `appexec` case:

```ts
if (frame.type === "btw") {
  const command = btwCommandFromFrame(frame as BtwCommandFrameInput);
  if (!command) return null;
  return { kind: "btw", command };
}
```

(Match the exact structural style of the existing `appexec` branch — if it uses a `switch` or destructuring, mirror that; keep the `btwCommandFromFrame` call and the null path identical.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol-btw.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — all 16 existing test files stay green (the new union member is additive).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/protocol.ts bun-apps/pi-agent-ext-webui/src/web-transport.ts bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts
git commit -m "feat(webui): add btw WS frame type and dispatch action"
```

### Task 7: snapshot store + broadcast forwarder

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-store.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BtwEvent`, `BtwThreadState`); existing `WebFrame` from `./protocol`.
- Produces: `interface BtwStore { apply(event: BtwEvent): void; state(): BtwThreadState }`; `createBtwStore(): BtwStore`; `createBtwForwarder(store: BtwStore, broadcast: (frame: WebFrame) => void): (event: BtwEvent) => void`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts
import { describe, expect, it } from "bun:test";
import type { WebFrame } from "../src/protocol";
import { createBtwForwarder, createBtwStore } from "../src/btw-store";
import type { BtwEvent, BtwThreadState } from "../src/btw-channels";

const STATE: BtwThreadState = {
  messages: [{ id: "btw-m-0", role: "user", text: "q", status: "done" }],
  mode: "contextual",
  model: null,
  thinking: null,
};

describe("createBtwStore", () => {
  it("defaults to an empty contextual thread", () => {
    expect(createBtwStore().state()).toEqual({
      messages: [],
      mode: "contextual",
      model: null,
      thinking: null,
    });
  });

  it("keeps only the latest thread state; notices do not clobber it", () => {
    const store = createBtwStore();
    store.apply({ type: "thread", state: STATE });
    store.apply({ type: "notice", text: "Injected into the main session" });
    expect(store.state()).toEqual(STATE);
  });
});

describe("createBtwForwarder", () => {
  it("applies thread events to the store AND broadcasts a btw frame", () => {
    const store = createBtwStore();
    const frames: WebFrame[] = [];
    const forward = createBtwForwarder(store, (frame) => frames.push(frame));

    const threadEvent: BtwEvent = { type: "thread", state: STATE };
    forward(threadEvent);
    expect(frames).toEqual([{ type: "btw", event: threadEvent }]);
    expect(store.state()).toEqual(STATE);

    const noticeEvent: BtwEvent = { type: "notice", text: "ok" };
    forward(noticeEvent);
    expect(frames).toEqual([{ type: "btw", event: threadEvent }, { type: "btw", event: noticeEvent }]);
    expect(store.state()).toEqual(STATE); // notice did not clobber the snapshot
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-store.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-webui/src/btw-store.ts
import type { WebFrame } from "./protocol";
import type { BtwEvent, BtwThreadState } from "./btw-channels";

const EMPTY_STATE: BtwThreadState = {
  messages: [],
  mode: "contextual",
  model: null,
  thinking: null,
};

/** Latest-snapshot store for GET /api/btw (pull-then-subscribe, D7). */
export interface BtwStore {
  apply(event: BtwEvent): void;
  state(): BtwThreadState;
}

export function createBtwStore(): BtwStore {
  let current: BtwThreadState | null = null;
  return {
    apply(event) {
      if (event.type === "thread") current = event.state;
    },
    state() {
      return current ?? EMPTY_STATE;
    },
  };
}

/** Bus event -> store update + broadcast of the new `btw` WebFrame (D5). */
export function createBtwForwarder(
  store: BtwStore,
  broadcast: (frame: WebFrame) => void,
): (event: BtwEvent) => void {
  return (event) => {
    store.apply(event);
    broadcast({ type: "btw", event });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-store.test.ts )`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-store.ts bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts
git commit -m "feat(webui): add btw latest-snapshot store and broadcast forwarder"
```

### Task 8: HTTP routes + wiring glue

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-routes.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (widen `WebuiSessionCtx`; subscribe `onBtwEvent` → forwarder; `dispatch` case `"btw"`; chain btw routes into `setHttpRoutes`)
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 (`onBtwEvent`, `emitBtwCommand`); Task 6 DispatchAction member `{ kind: "btw"; command: BtwCommand }`; Task 7 (`createBtwStore`, `createBtwForwarder`); existing `HttpRouteHandler = (req, srv) => Response | null` and `server.setHttpRoutes`, `server.broadcast`, `renderRoutes`/`outputRoutes` chain at `webui-wiring.ts` ~L370, `WebuiSessionCtx` (currently `{ abort(): void; ui: WebuiUi }` — the real `ExtensionContext` is a structural superset per the file's own comment).
- Produces: `createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler` with `BtwRoutesDeps = { getState(): BtwThreadState | null; getModels(): BtwModelSummary[] }` and `BtwModelSummary = { provider: string; id: string; api: string }`; `GET /api/btw` + `GET /api/btw/models` responses (`application/json; charset=utf-8`, `Cache-Control: no-store`); `WebuiSessionCtx` now includes `modelRegistry`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server";
import { createBtwRoutes } from "../src/btw-routes";
import type { BtwThreadState } from "../src/btw-channels";

const servers: WebServer[] = [];
afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
});

const STATE: BtwThreadState = {
  messages: [{ id: "btw-m-0", role: "user", text: "q", status: "done" }],
  mode: "contextual",
  model: null,
  thinking: null,
};

function startServer(deps: Parameters<typeof createBtwRoutes>[0]): WebServer {
  const server = new WebServer({ port: 0 });
  servers.push(server);
  server.setHttpRoutes(createBtwRoutes(deps));
  server.start();
  return server;
}

describe("GET /api/btw", () => {
  it("returns the latest thread snapshot with no-store headers", async () => {
    const server = startServer({ getState: () => STATE, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(STATE);
  });

  it("returns an empty default state when nothing has been emitted yet", async () => {
    const server = startServer({ getState: () => null, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(await res.json()).toEqual({ messages: [], mode: "contextual", model: null, thinking: null });
  });
});

describe("GET /api/btw/models", () => {
  it("returns the registry-backed model list", async () => {
    const models = [{ provider: "anthropic", id: "claude-sonnet-4", api: "anthropic" }];
    const server = startServer({ getState: () => STATE, getModels: () => models });
    const res = await fetch(`${server.url}/api/btw/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(models);
  });
});

describe("route chaining", () => {
  it("returns null for other paths so the existing chain continues", () => {
    const handler = createBtwRoutes({ getState: () => STATE, getModels: () => [] });
    expect(handler(new Request("http://localhost/api/views"), undefined as never)).toBeNull();
    expect(handler(new Request("http://localhost/output/x.png"), undefined as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-routes.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-routes`.

- [ ] **Step 3: Write the route handler**

```ts
// bun-apps/pi-agent-ext-webui/src/btw-routes.ts
import type { HttpRouteHandler } from "./web-server";
import type { BtwThreadState } from "./btw-channels";

/** Registry-backed model summary fed to the panel's Model dropdown (D12). */
export interface BtwModelSummary {
  provider: string;
  id: string;
  api: string;
}

export interface BtwRoutesDeps {
  getState(): BtwThreadState | null;
  getModels(): BtwModelSummary[];
}

const EMPTY_STATE: BtwThreadState = {
  messages: [],
  mode: "contextual",
  model: null,
  thinking: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** GET /api/btw (thread snapshot, D7) + GET /api/btw/models (registry list, D12). */
export function createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/btw") {
      return jsonResponse(deps.getState() ?? EMPTY_STATE);
    }
    if (req.method === "GET" && url.pathname === "/api/btw/models") {
      return jsonResponse(deps.getModels());
    }
    return null;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-routes.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire everything into webui-wiring.ts (glue — covered end-to-end by Task 11's contract test)**

In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, five additive edits:

1. Imports:

```ts
import { createBtwRoutes } from "./btw-routes";
import { createBtwForwarder, createBtwStore } from "./btw-store";
import { emitBtwCommand, onBtwEvent } from "./btw-channels";
```

2. Widen `WebuiSessionCtx` (the real `ExtensionContext` is a structural superset, per the interface's own comment — this only narrows less):

```ts
interface WebuiSessionCtx {
  abort(): void;
  ui: WebuiUi;
  modelRegistry: { getAvailable(): Array<{ provider: string; id: string; api: string }> };
}
```

(If the SDK `ModelRegistry` type is importable with the same specifier style the file already uses for other SDK types, type the member as `ModelRegistry` instead of the structural literal — both satisfy the route mapping below.)

3. In the factory body, next to where `bound` is declared, add the store + subscription (webui subscribes during factory setup, BEFORE any `session_start` fires, so it catches btw's initial thread event):

```ts
const btwStore = createBtwStore();
const forwardBtwEvent = createBtwForwarder(btwStore, (frame) => server.broadcast(frame));
onBtwEvent(pi.events, forwardBtwEvent);
```

4. In `dispatch(action)`, next to the existing `case "appexec":` block, add:

```ts
case "btw":
  if (pi.events) emitBtwCommand(pi.events, action.command);
  break;
```

5. Replace the HTTP route chain (~L370) so btw routes are consulted first:

```ts
server.setHttpRoutes(
  (req, srv) =>
    createBtwRoutes({
      getState: () => btwStore.state(),
      getModels: () =>
        (bound?.ctx.modelRegistry?.getAvailable() ?? []).map((m) => ({
          provider: m.provider,
          id: m.id,
          api: m.api,
        })),
    })(req, srv) ?? renderRoutes(req, srv) ?? outputRoutes(req, srv),
);
```

Note (soft spot): the `provider`/`id`/`api` field mapping mirrors the btw override-entry payload convention; if the SDK `Model` names a field differently (e.g. `modelId`), adjust the three keys here AND keep `BtwModelSummary` unchanged.

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — the widened ctx and additive glue break nothing.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-routes.ts bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts
git commit -m "feat(webui): serve /api/btw snapshot and model list, bridge bus to WS frames"
```


## Phase 3 — panel UI

### Task 9: shell panel markup + pure helpers

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (add `BTW_FRAME`, `BTW_MESSAGE_HTML` exports; extend `RENDER_SHELL_HTML` with panel markup + CSS)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts`

**Interfaces:**
- Consumes: existing `RENDER_SHELL_HTML` export and its header/main DOM structure (`header#tabs`, `main` with `#meta` + `#content`, `.webui-toolbar`); prior-art pure-helper style of `APPEXEC_FRAME(id, action, tweak?)`.
- Produces: `BTW_FRAME(kind: string, extra?: Record<string, unknown>): { type: "btw"; kind: string; [k: string]: unknown }`; `BTW_MESSAGE_HTML(m: BtwMessageSnapshot): string` (HTML string for one message row); panel DOM ids `btw-panel`, `btw-collapse`, `btw-messages`, `btw-input`, `btw-ask`, `btw-new`, `btw-clear`, `btw-inject`, `btw-summarize`, `btw-mode`, `btw-model`, `btw-thinking`; localStorage key `"btw-panel-collapsed"`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
import { describe, expect, it } from "bun:test";
import { BTW_FRAME, BTW_MESSAGE_HTML, RENDER_SHELL_HTML } from "../src/render-shell";

describe("RENDER_SHELL_HTML btw panel scaffold", () => {
  it("embeds the btw side panel structure", () => {
    expect(RENDER_SHELL_HTML).toContain('id="btw-panel"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-messages"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-input"');
    for (const id of ["btw-collapse", "btw-ask", "btw-new", "btw-clear", "btw-inject", "btw-summarize", "btw-mode", "btw-model", "btw-thinking"]) {
      expect(RENDER_SHELL_HTML).toContain(`id="${id}"`);
    }
  });

  it("uses the agreed localStorage key for the collapse state", () => {
    expect(RENDER_SHELL_HTML).toContain("btw-panel-collapsed");
  });
});

describe("BTW_FRAME pure helper", () => {
  it("builds flat btw command frames", () => {
    expect(BTW_FRAME("ask", { text: "hi" })).toEqual({ type: "btw", kind: "ask", text: "hi" });
    expect(BTW_FRAME("mode", { mode: "tangent" })).toEqual({ type: "btw", kind: "mode", mode: "tangent" });
  });

  it("omits the extra keys entirely when none are given", () => {
    const f = BTW_FRAME("clear");
    expect(f).toEqual({ type: "btw", kind: "clear" });
    expect("text" in f).toBe(false);
  });
});

describe("BTW_MESSAGE_HTML pure helper", () => {
  it("renders a snapshot row keyed by id with escaped text", () => {
    const html = BTW_MESSAGE_HTML({ id: "btw-m-1", role: "assistant", text: "a < b", status: "done" });
    expect(html).toContain('data-id="btw-m-1"');
    expect(html).toContain("a &lt; b");
    expect(html).not.toContain("btw-status");
  });

  it("renders the status line for non-done snapshots", () => {
    const html = BTW_MESSAGE_HTML({
      id: "btw-m-1",
      role: "assistant",
      text: "ans",
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(html).toContain("btw-status");
    expect(html).toContain("running-tool: bash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: FAIL — `BTW_FRAME` / `BTW_MESSAGE_HTML` not exported; panel ids absent from `RENDER_SHELL_HTML`.

- [ ] **Step 3: Implement the pure helpers**

In `bun-apps/pi-agent-ext-webui/src/render-shell.ts`, next to `APPEXEC_FRAME`:

```ts
/** Outbound btw command frame for the /ws send path (panel -> engine). */
export function BTW_FRAME(
  kind: string,
  extra?: Record<string, unknown>,
): { type: "btw"; kind: string; [key: string]: unknown } {
  return extra ? { type: "btw", kind, ...extra } : { type: "btw", kind };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// (If render-shell.ts already defines an escapeHtml, reuse it instead of adding a second one.)

/** One pre-reduced message snapshot -> panel row HTML (append/patch keyed by data-id). */
export function BTW_MESSAGE_HTML(m: {
  id: string;
  role: string;
  text: string;
  status: string;
  statusText?: string;
}): string {
  const status =
    m.status === "done"
      ? ""
      : `<span class="btw-status">${escapeHtml(m.statusText ?? m.status)}</span>`;
  return `<div class="btw-msg btw-${m.role}" data-id="${m.id}"><div class="btw-text">${escapeHtml(m.text)}</div>${status}</div>`;
}
```

- [ ] **Step 4: Add the panel markup + CSS to RENDER_SHELL_HTML**

Inside the `RENDER_SHELL_HTML` template string: add the CSS to the existing `<style>` block, and wrap the existing `<main>` usage in a flex row with the new `<aside>`. Concretely — extend the style block with:

```css
#shell-row { display: flex; flex: 1; min-height: 0; }
#shell-row > main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
#btw-panel { flex: 0 0 340px; display: flex; flex-direction: column; border-left: 1px solid #333; padding: 8px; gap: 6px; min-height: 0; }
body.btw-collapsed #btw-panel { display: none; }
#btw-messages { flex: 1 1 auto; overflow-y: auto; font-size: 13px; }
.btw-msg { margin: 4px 0; padding: 6px 8px; border-radius: 6px; background: #1b1b1b; }
.btw-msg.btw-user { background: #16324f; }
.btw-status { display: block; margin-top: 4px; color: #e0a030; font-size: 11px; }
.btw-notice { margin: 4px 0; padding: 6px 8px; border-radius: 6px; color: #7ec87e; background: #14290f; font-size: 12px; }
#btw-bar { display: flex; flex-wrap: wrap; gap: 4px; }
#btw-bar button, #btw-bar select { font-size: 12px; padding: 3px 8px; }
#btw-compose { display: flex; gap: 4px; }
#btw-input { flex: 1 1 auto; }
```

And change the main layout from `<main>…</main>` to:

```html
<div id="shell-row">
  <main><!-- existing #meta + #content markup, unchanged --></main>
  <aside id="btw-panel">
    <div id="btw-bar">
      <button id="btw-collapse" title="Collapse/expand the btw panel">«</button>
      <button id="btw-new">New</button>
      <button id="btw-clear">Clear</button>
      <button id="btw-inject">Inject</button>
      <button id="btw-summarize">Summarize</button>
      <button id="btw-mode">Mode: contextual</button>
      <select id="btw-model"><option value="">Main session model</option></select>
      <select id="btw-thinking">
        <option value="">Thinking: main default</option>
        <option value="off">off</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </div>
    <div id="btw-messages"></div>
    <div id="btw-compose">
      <input id="btw-input" type="text" placeholder="Ask a tangent question..." />
      <button id="btw-ask">Ask</button>
    </div>
  </aside>
</div>
```

(Adapt class names/spacing to the file's existing CSS conventions; the required contract is the id list above + the `body.btw-collapsed` hide rule + flex-row layout.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — existing render-shell tests (constant, GET / ordering) unaffected.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
git commit -m "feat(webui): add btw side panel markup and frame/message helpers"
```

### Task 10: shell client logic (pull-then-subscribe, first inbound WS consumer, command sends)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (`RENDER_SHELL_HTML` `<script>` block)
- Test: extend `bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts`

**Interfaces:**
- Consumes: Task 9 (`BTW_FRAME` shape, panel ids, `BTW_MESSAGE_HTML` row contract); existing shell send path used by `sendAppexecResponse` (the `/ws` socket with 2s-retry reconnect — reuse its raw send, do not open a second socket); existing `new EventSource('/api/events')` refresh loop (unchanged).
- Produces: shell JS behaviors — `fetch('/api/btw')` pull on load, `fetch('/api/btw/models')` dropdown fill, `ws.onmessage` handling `{ type: "btw"; event }` frames (FIRST inbound WS consumer), message list append/patch/prune keyed by `data-id`, `localStorage` collapse persistence, outbound `btw` frames via the existing socket.

- [ ] **Step 1: Write the failing test (append to tests/render-shell-btw.test.ts)**

```ts
describe("RENDER_SHELL_HTML btw client logic", () => {
  it("ships the first inbound ws handler for btw frames", () => {
    expect(RENDER_SHELL_HTML).toContain("ws.onmessage");
    expect(RENDER_SHELL_HTML).toContain('frame.type === "btw"');
  });

  it("pulls the thread snapshot and model list on load (pull-then-subscribe)", () => {
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw')");
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw/models')");
  });

  it("sends btw commands over the existing /ws socket", () => {
    expect(RENDER_SHELL_HTML).toContain("sendBtw(");
    expect(RENDER_SHELL_HTML.split("new WebSocket(").length - 1).toBe(1); // exactly one construction site
  });

  it("keeps the SSE refresh loop as-is", () => {
    expect(RENDER_SHELL_HTML).toContain("new EventSource('/api/events')");
  });
});
```

Note the occurrence-count guard: the shell must keep exactly ONE `new WebSocket(` construction — the existing `connectWs` in `RENDER_SHELL_HTML` (which builds its single `/ws` socket once). The panel reuses that socket; the test guards against adding a second construction site.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: FAIL — the four new describe cases fail (no `ws.onmessage`, no btw fetches, no `sendBtw`).

- [ ] **Step 3: Implement the shell client logic**

Add to the `<script>` block in `RENDER_SHELL_HTML` (single-quoted strings to match the test assertions):

```js
// --- btw side panel ---
var btwState = { messages: [], mode: 'contextual', model: null, thinking: null };
var btwModels = [];

function btwApplyCollapsed() {
  document.body.classList.toggle('btw-collapsed', localStorage.getItem('btw-panel-collapsed') === '1');
}

function btwRenderMessages(messages) {
  var list = document.getElementById('btw-messages');
  if (!list) return;
  var seen = {};
  messages.forEach(function (m) {
    seen[m.id] = true;
    var existing = list.querySelector('[data-id="' + m.id + '"]');
    var html = btwMessageHtml(m);
    if (existing) existing.outerHTML = html;
    else list.insertAdjacentHTML('beforeend', html);
  });
  Array.prototype.forEach.call(list.querySelectorAll('[data-id]'), function (el) {
    if (!seen[el.getAttribute('data-id')]) el.remove();
  });
  list.scrollTop = list.scrollHeight;
}

function btwMessageHtml(m) {
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var status = m.status === 'done' ? '' : '<span class="btw-status">' + esc(m.statusText || m.status) + '</span>';
  return '<div class="btw-msg btw-' + m.role + '" data-id="' + m.id + '"><div class="btw-text">' + esc(m.text) + '</div>' + status + '</div>';
}

function btwApplyEvent(event) {
  if (event.type === 'thread') {
    btwState = event.state;
    btwRenderMessages(event.state.messages);
    var modeBtn = document.getElementById('btw-mode');
    if (modeBtn) modeBtn.textContent = 'Mode: ' + event.state.mode;
  } else if (event.type === 'notice') {
    var list = document.getElementById('btw-messages');
    if (list) list.insertAdjacentHTML('beforeend', '<div class="btw-notice">' + String(event.text).replace(/</g, '&lt;') + '</div>');
  }
}

function sendBtw(kind, extra) {
  var frame = { type: 'btw', kind: kind };
  if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) frame[k] = extra[k]; });
  sendRaw(JSON.stringify(frame));
}

function btwInit() {
  btwApplyCollapsed();
  var collapse = document.getElementById('btw-collapse');
  if (collapse) collapse.addEventListener('click', function () {
    var collapsed = document.body.classList.toggle('btw-collapsed');
    localStorage.setItem('btw-panel-collapsed', collapsed ? '1' : '0');
  });

  fetch('/api/btw').then(function (r) { return r.ok ? r.json() : null; }).then(function (state) {
    if (state && state.messages) { btwState = state; btwRenderMessages(state.messages); }
  });

  fetch('/api/btw/models').then(function (r) { return r.ok ? r.json() : []; }).then(function (models) {
    btwModels = models || [];
    var sel = document.getElementById('btw-model');
    if (!sel) return;
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Main session model';
    sel.appendChild(none);
    btwModels.forEach(function (m, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = m.provider + '/' + m.id;
      sel.appendChild(opt);
    });
  });

  document.getElementById('btw-ask').addEventListener('click', function () {
    var input = document.getElementById('btw-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtw('ask', { text: text });
  });
  ['new', 'clear', 'inject', 'summarize'].forEach(function (kind) {
    document.getElementById('btw-' + kind).addEventListener('click', function () { sendBtw(kind); });
  });
  document.getElementById('btw-mode').addEventListener('click', function () {
    sendBtw('mode', { mode: btwState.mode === 'contextual' ? 'tangent' : 'contextual' });
  });
  document.getElementById('btw-model').addEventListener('change', function () {
    var m = btwModels[Number(this.value)];
    sendBtw('model', { model: m ? { provider: m.provider, id: m.id, api: m.api } : null });
  });
  document.getElementById('btw-thinking').addEventListener('change', function () {
    sendBtw('thinking', { level: this.value === '' ? null : this.value });
  });
}
btwInit();

// First inbound consumer of the /ws socket (it was send-only before this change).
ws.onmessage = function (message) {
  var frame;
  try { frame = JSON.parse(message.data); } catch (e) { return; }
  if (frame && frame.type === 'btw' && frame.event) btwApplyEvent(frame.event);
};
```

Placement notes for the implementer:

- `sendRaw(payload)` — send `payload` through the SAME `/ws` socket `sendAppexecResponse` uses. If that function inlines its `ws.send(...)` call, extract or reuse the identical send expression inside `sendBtw` (do not duplicate the reconnect logic; the existing 2s-retry socket stays the only one). Do NOT build the `{ type: 'btw', ... }` object with an `extra` wrapper — the frame must be FLAT (`{ type: 'btw', kind, text?, mode?, model?, level? }`), matching `BtwCommandFrameSchema`; if the spread of `extra` keys above is awkward, write `var frame = { type: 'btw', kind: kind }; if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) frame[k] = extra[k]; });` and `JSON.stringify(frame)`.
- `ws.onmessage` — assign it at the site where the `/ws` socket is created/opened (next to `sendAppexecResponse`'s definition), so `ws` refers to the live, reconnecting socket instance.
- `btwInit()` — call it at the end of the existing DOM-ready/init sequence, after the tab/view wiring, so all `getElementById` targets exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: PASS (9 tests: 5 from Task 9 + 4 new).

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
git commit -m "feat(webui): wire btw panel client logic over /ws and /api/btw"
```

## Phase 4 — contract + gates

### Task 11: cross-package contract test

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/tests/btw-contract.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BTW_COMMAND_CHANNEL`, `BTW_EVENT_CHANNEL`, `emitBtwCommand`, `onBtwEvent`); Task 7 (`createBtwStore`, `createBtwForwarder`); the btw package's published channel values (redeclared locally as string literals below — the duplication IS the contract under test).
- Produces: a test proving both extensions' bus-facing seams interoperate over a plain `{ on, emit }` fake bus with NO import between the two packages, plus a `package.json` assertion that webui declares no dependency on `@repo/pi-agent-ext-btw`.

**Chosen form (documented per Phase context):** the test lives in the webui package and uses webui's REAL seam modules; the btw side is represented by (a) locally redeclared channel-string constants copied from `pi-agent-ext-btw/src/btw/webui-events.ts` and (b) a test-local fake engine-side subscriber/emitter using those constants. This keeps the packages decoupled while pinning the string contract — if either package renames a channel, this test fails.

- [ ] **Step 1: Write the test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-contract.test.ts
import { describe, expect, it } from "bun:test";
import {
  BTW_COMMAND_CHANNEL,
  BTW_EVENT_CHANNEL,
  emitBtwCommand,
  onBtwEvent,
} from "../src/btw-channels";
import { createBtwForwarder, createBtwStore } from "../src/btw-store";
import type { BtwThreadState } from "../src/btw-channels";

// btw-side channel names, redeclared verbatim from
// bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts — there is deliberately
// NO import between the two packages; these literals are the contract.
const BTW_COMMAND_CHANNEL_BTW_SIDE = "webui:btw-command";
const BTW_EVENT_CHANNEL_BTW_SIDE = "btw:event";

const THREAD_STATE: BtwThreadState = {
  messages: [
    { id: "btw-m-0", role: "user", text: "why did the render fail?", status: "done" },
    { id: "btw-m-1", role: "assistant", text: "the shader compile step", status: "done" },
  ],
  mode: "contextual",
  model: null,
  thinking: null,
};

function fakeBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.forEach((handler) => handler(data));
    },
  };
}

describe("btw <-> webui bus contract", () => {
  it("channel names match the btw package's published constants", () => {
    expect(BTW_COMMAND_CHANNEL).toBe(BTW_COMMAND_CHANNEL_BTW_SIDE);
    expect(BTW_EVENT_CHANNEL).toBe(BTW_EVENT_CHANNEL_BTW_SIDE);
  });

  it("drives ask -> snapshot -> frame across both seams with no package dependency", () => {
    const bus = fakeBus();

    // btw side (fake engine): a subscriber on the command channel ...
    const receivedCommands: unknown[] = [];
    bus.on(BTW_COMMAND_CHANNEL_BTW_SIDE, (data) => receivedCommands.push(data));

    // webui side: store + forwarder wired to the bus, broadcast recorder
    const store = createBtwStore();
    const frames: unknown[] = [];
    const dispose = onBtwEvent(bus, createBtwForwarder(store, (frame) => frames.push(frame)));

    // ... and an emitter of pre-reduced thread snapshots on the event channel
    bus.emit(BTW_EVENT_CHANNEL_BTW_SIDE, { type: "thread", state: THREAD_STATE });

    // snapshot arrived in the pull store AND went out as the new WS frame
    expect(store.state()).toEqual(THREAD_STATE);
    expect(frames).toEqual([{ type: "btw", event: { type: "thread", state: THREAD_STATE } }]);

    // panel command flows back over the command channel
    emitBtwCommand(bus, { kind: "ask", text: "and the fix?" });
    expect(receivedCommands).toEqual([{ kind: "ask", text: "and the fix?" }]);

    dispose();
  });

  it("webui package.json declares no dependency on the btw package", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url).pathname).json()) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@repo/pi-agent-ext-btw"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (it should pass immediately — it pins Tasks 1/5/7 output)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-contract.test.ts )`
Expected: PASS (3 tests). If the channel-name test fails, a seam module diverged — fix the seam, never the test.

- [ ] **Step 3: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/tests/btw-contract.test.ts
git commit -m "test(webui): pin the btw/webui bus contract without package coupling"
```

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
