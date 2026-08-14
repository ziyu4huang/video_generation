/**
 * protocol-btw.test.ts — btw WS frame schema + transport mapping (Task 6).
 *
 * Pins the inbound `{ type: "btw", kind, ... }` frame (BtwCommandFrameSchema in
 * the InboundCommandSchema union) and the parseCommand mapping to the
 * `{ kind: "btw", command }` DispatchAction via btwCommandFromFrame (Task 5).
 * Inconsistent bodies resolve to null (ignored, spec §6) — never mis-routed.
 */
import { describe, expect, it } from "bun:test";
import { validateInbound } from "../src/protocol.js";
import { WebTransport } from "../src/web-transport.js";

const t = new WebTransport();

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
    expect(
      validateInbound({ type: "btw", kind: "model", model: { provider: "p", id: "m", api: "a" } }),
    ).toEqual({
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
    expect(t.parseCommand({ type: "btw", kind: "mode", mode: "tangent" } as never)).toEqual({
      kind: "btw",
      command: { kind: "mode", mode: "tangent" },
    });
    expect(t.parseCommand({ type: "btw", kind: "summarize" } as never)).toEqual({
      kind: "btw",
      command: { kind: "summarize" },
    });
  });

  it("parseCommand returns null for inconsistent btw bodies", () => {
    expect(t.parseCommand({ type: "btw", kind: "ask" } as never)).toBeNull();
    expect(t.parseCommand({ type: "btw", kind: "mode", mode: "bogus" } as never)).toBeNull();
  });
});
