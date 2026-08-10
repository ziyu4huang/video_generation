import { describe, expect, it } from "bun:test";
import {
  toWebFrame,
  validateInbound,
  type EventLike,
} from "../src/protocol.js";

describe("validateInbound (schema parse/validate)", () => {
  it("accepts each valid agentic command", () => {
    expect(validateInbound({ type: "prompt", text: "hi" })).toEqual({ type: "prompt", text: "hi" });
    expect(validateInbound({ type: "steer", text: "x" })?.type).toBe("steer");
    expect(validateInbound({ type: "followUp", text: "y" })?.type).toBe("followUp");
  });
  it("accepts abort / appexec / subscribe / unsubscribe", () => {
    expect(validateInbound({ type: "abort" })?.type).toBe("abort");
    expect(validateInbound({ type: "appexec" })?.type).toBe("appexec");
    expect(validateInbound({ type: "subscribe" })?.type).toBe("subscribe");
    expect(validateInbound({ type: "unsubscribe" })?.type).toBe("unsubscribe");
  });
  it("rejects malformed: unknown type", () => {
    expect(validateInbound({ type: "nonsense" })).toBeNull();
  });
  it("rejects malformed: prompt without text", () => {
    expect(validateInbound({ type: "prompt" })).toBeNull();
    expect(validateInbound({ type: "prompt", text: 42 })).toBeNull();
  });
  it("rejects non-objects / wrong discriminator", () => {
    expect(validateInbound(null)).toBeNull();
    expect(validateInbound("prompt")).toBeNull();
    expect(validateInbound({})).toBeNull();
  });
});

describe("toWebFrame (event -> outbound, .details forwarded intact)", () => {
  const cases: Array<[string, EventLike]> = [
    ["message_start", { type: "message_start" }],
    ["message_update", { type: "message_update" }],
    ["message_end", { type: "message_end" }],
    ["turn_start", { type: "turn_start" }],
    ["turn_end", { type: "turn_end" }],
    ["agent_settled", { type: "agent_settled" }],
    ["session_compact", { type: "session_compact" }],
    ["session_before_compact", { type: "session_before_compact" }],
  ];
  for (const [label, ev] of cases) {
    it(`forwards ${label} with type intact`, () => {
      expect(toWebFrame(ev).type).toBe(label);
    });
  }
  it("forwards tool_execution_* with toolName + details", () => {
    const f = toWebFrame({ type: "tool_execution_start", toolName: "bash", details: { cmd: "ls" } });
    expect(f.type).toBe("tool_execution_start");
    expect((f as { toolName?: string }).toolName).toBe("bash");
    expect((f as { details?: unknown }).details).toEqual({ cmd: "ls" });
  });
  it("forwards tool_result .details verbatim (no field drop)", () => {
    const details = { diff: "x", patch: "y", extra: { nested: [1, 2] } };
    const f = toWebFrame({ type: "tool_result", details });
    expect((f as { details?: unknown }).details).toEqual(details);
  });
  it("maps an unknown-but-reachable event shape to a generic frame (forward-compat, no throw)", () => {
    expect(() => toWebFrame({ type: "future_event", details: { a: 1 } })).not.toThrow();
  });
});
