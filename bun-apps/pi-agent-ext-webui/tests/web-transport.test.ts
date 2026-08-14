/**
 * web-transport.test.ts — RED tests for the WebTransport deep module (Task 1).
 *
 * Per specs/04 §3 + task-1-brief.md. The deep module owns two pure methods:
 *  - parseCommand: a VALIDATED ClientFrame -> a DispatchAction DESCRIPTOR (it does
 *    NOT call pi, does NOT touch the mutex — the op->pi-call resolution is Task 3's
 *    job, after the gate). Agentic descriptors carry source:"extension" so the
 *    wiring gates via MutexController.handleInput("extension").
 *  - mapEvent: a host event -> a WebFrame, delegating to protocol.toWebFrame.
 *
 * Purity is the whole point (spec §3 depth): the module is fully testable through
 * its interface with no live session, no I/O, no runtime pi/Bun dependency.
 */
import { describe, expect, it } from "bun:test";
import { WebTransport } from "../src/web-transport.js";
import { toWebFrame } from "../src/protocol.js";
import type { ClientFrame, DispatchAction, EventLike, WebFrame } from "../src/protocol.js";

const t = new WebTransport();

describe("WebTransport.parseCommand — dispatch matrix", () => {
  it("prompt -> agentic descriptor (op prompt, text forwarded, source extension, no pi call)", () => {
    // Asserts the DESCRIPTOR shape — parseCommand must NOT call pi (Task 3 resolves it).
    expect(t.parseCommand({ type: "prompt", text: "hi" })).toEqual({
      kind: "agentic",
      op: "prompt",
      text: "hi",
      source: "extension",
    });
  });

  it("steer -> agentic with op + text + source preserved", () => {
    expect(t.parseCommand({ type: "steer", text: "x" })).toEqual({
      kind: "agentic",
      op: "steer",
      text: "x",
      source: "extension",
    });
  });

  it("followUp -> agentic with op + text + source preserved", () => {
    expect(t.parseCommand({ type: "followUp", text: "y" })).toEqual({
      kind: "agentic",
      op: "followUp",
      text: "y",
      source: "extension",
    });
  });

  it("abort -> agentic descriptor, no text", () => {
    expect(t.parseCommand({ type: "abort" })).toEqual({
      kind: "agentic",
      op: "abort",
      source: "extension",
    });
  });

  it("appexec respond (id+action) -> typed bypass descriptor", () => {
    const d = t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "p1", action: "approve" } });
    expect(d).toEqual({ kind: "appexec", op: "respond", id: "p1", action: "approve" });
  });

  it("appexec respond with tweak surfaces tweak", () => {
    const d = t.parseCommand({
      type: "appexec",
      extra: { kind: "respond", id: "p2", action: "regenerate", tweak: "more red" },
    });
    expect(d).toEqual({
      kind: "appexec", op: "respond", id: "p2", action: "regenerate", tweak: "more red",
    });
  });

  it("appexec respond is NOT agentic (NO source field) — bypasses the mutex", () => {
    // Task 2's wiring branches on `kind === "agentic"` BEFORE touching the mutex;
    // a respond has kind "appexec" and no `source`, so it is never routed through
    // handleInput (spec §6).
    const d = t.parseCommand({
      type: "appexec", extra: { kind: "respond", id: "p3", action: "approve" },
    }) as DispatchAction;
    expect(d.kind).toBe("appexec");
    expect((d as { source?: unknown }).source).toBeUndefined();
  });

  it("appexec with no extra (unknown op) -> null (ignored at parse time, spec §6)", () => {
    expect(t.parseCommand({ type: "appexec" })).toBeNull();
  });

  it("appexec with an unknown op in extra -> null (ignored, NOT rejected by schema)", () => {
    expect(t.parseCommand({ type: "appexec", extra: { kind: "nope", id: "x" } })).toBeNull();
  });

  it("appexec respond missing id or action (malformed) -> null (ignored)", () => {
    expect(t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "x" } })).toBeNull();
    expect(t.parseCommand({ type: "appexec", extra: { kind: "respond", action: "a" } })).toBeNull();
  });

  it("appexec respond with a non-string tweak -> null (ignored)", () => {
    expect(
      t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "x", action: "a", tweak: 5 } })
    ).toBeNull();
  });

  it("subscribe -> control descriptor", () => {
    expect(t.parseCommand({ type: "subscribe" })).toEqual({
      kind: "control",
      op: "subscribe",
    });
  });

  it("unsubscribe -> control descriptor", () => {
    expect(t.parseCommand({ type: "unsubscribe" })).toEqual({
      kind: "control",
      op: "unsubscribe",
    });
  });

  it("unknown type (defensive) -> null — never mis-routed through any gate (spec §6)", () => {
    // ClientFrame is a closed, validated union, so a well-typed input can never be
    // unknown. Defensively, an unknown type must NOT be silently routed through
    // agentic (which would spuriously acquire the lock) nor appexec — it returns
    // null so the caller ignores it. Malformed rejection is delegated to
    // validateInbound (protocol.ts); this asserts the defensive tail end.
    expect(t.parseCommand({ type: "nonsense" } as unknown as ClientFrame)).toBeNull();
  });

  it("parseCommand RETURNS a descriptor — the op->pi-call table is NOT executed here", () => {
    // Purity contract: spec §3 encodes prompt->sendUserMessage(text) as a
    // DESCRIPTOR, resolved in Task 3 after the gate returns "continue". Assert
    // the shape, never a side effect.
    const d = t.parseCommand({ type: "prompt", text: "hello" });
    expect(d).toEqual({ kind: "agentic", op: "prompt", text: "hello", source: "extension" });
  });
});

describe("WebTransport.mapEvent — delegates toWebFrame, .details preserved", () => {
  // One case per reachable host event type (ticket 01 + spec §2).
  const events: Array<[string, EventLike]> = [
    ["message_start", { type: "message_start" }],
    ["message_update", { type: "message_update" }],
    ["message_end", { type: "message_end" }],
    ["tool_execution_start", { type: "tool_execution_start", toolName: "edit", details: { diff: "d" } }],
    ["tool_execution_update", { type: "tool_execution_update", toolName: "bash", details: { partial: "ls" } }],
    ["tool_execution_end", { type: "tool_execution_end", toolName: "bash", details: { exitCode: 0 } }],
    ["tool_result", { type: "tool_result", details: { patch: "p" } }],
    ["turn_start", { type: "turn_start" }],
    ["turn_end", { type: "turn_end" }],
    ["agent_settled", { type: "agent_settled" }],
    ["session_compact", { type: "session_compact" }],
    ["session_before_compact", { type: "session_before_compact" }],
  ];

  for (const [label, ev] of events) {
    it(`maps ${label} preserving type + details, delegating to toWebFrame`, () => {
      const f = t.mapEvent(ev);
      // Delegation: mapEvent output equals protocol.toWebFrame output exactly.
      expect(f).toEqual(toWebFrame(ev));
      expect(f.type).toBe(label);
      if (ev.details !== undefined) {
        expect((f as { details?: unknown }).details).toEqual(ev.details);
      }
    });
  }

  it("tool_execution_* forwards toolName intact", () => {
    const f = t.mapEvent({ type: "tool_execution_start", toolName: "bash", details: { cmd: "ls" } }) as WebFrame;
    expect((f as { toolName?: string }).toolName).toBe("bash");
  });

  it("tool_result .details forwarded verbatim (no field drop)", () => {
    const details = { diff: "x", patch: "y", extra: { nested: [1, 2] } };
    const f = t.mapEvent({ type: "tool_result", details }) as WebFrame;
    expect((f as { details?: unknown }).details).toEqual(details);
  });

  it("unknown-but-reachable event shape -> generic frame, never throws (spec §6 forward-compat)", () => {
    expect(() => t.mapEvent({ type: "future_event", details: { a: 1 } })).not.toThrow();
  });
});

describe("WebTransport purity", () => {
  it("parseCommand is deterministic (same input -> same output)", () => {
    const a = t.parseCommand({ type: "prompt", text: "z" });
    const b = t.parseCommand({ type: "prompt", text: "z" });
    expect(a).toEqual(b);
  });

  it("mapEvent does not mutate the input event", () => {
    const ev: EventLike = { type: "tool_result", details: { a: 1 } };
    const snapshot = JSON.parse(JSON.stringify(ev));
    t.mapEvent(ev);
    expect(ev).toEqual(snapshot);
  });
});
