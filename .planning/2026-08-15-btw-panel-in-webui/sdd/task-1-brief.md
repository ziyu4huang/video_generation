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

