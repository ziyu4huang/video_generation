// bun-apps/s2-agent-ext-btw/__tests__/webui-events.test.ts
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
