import { describe, expect, it } from "bun:test";
import {
  toWebFrame,
  validateCardSendExtra,
  validateInbound,
  type EventLike,
  type WebFrame,
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

// --- event-cards (01): the card frame contract --------------------------------
// There is NO outbound validator (inbound-only module: validateInbound); the
// outbound contract is pinned two ways instead: (1) the union member via a
// typed literal (tsc fails if the member or a field disappears/renames) and
// (2) toWebFrame forwarding a full-field card 1:1 (the outbound seam a host
// card event rides through).
describe("card frame (event-cards 01)", () => {
  /** Every field of the union member, exercised at once. */
  const cardEvent: EventLike = {
    type: "card",
    id: "card-7",
    kind: "readonly",
    title: "webui:open",
    source: "bus",
    ts: 1739380000000,
    attention: "silent",
    body: { text: '{"reason":"deep-link"}' },
  };

  it("the full-field frame is accepted by the WebFrame card union member (compile-time pin)", () => {
    // Assignability against the NARROW member (not the forward-compat
    // catch-all) — a dropped/renamed field fails `bun run typecheck` here.
    const frame: Extract<WebFrame, { type: "card" }> = {
      type: "card",
      id: "card-7",
      kind: "readonly",
      title: "webui:open",
      source: "bus",
      ts: 1739380000000,
      attention: "silent",
      body: { text: '{"reason":"deep-link"}' },
    };
    expect(frame.body.text).toBe('{"reason":"deep-link"}');
    expect(frame.kind).toBe("readonly");
    expect(frame.attention).toBe("silent");
  });

  it("toWebFrame forwards a full-field card frame 1:1 (no field dropped, none added)", () => {
    const f = toWebFrame(cardEvent);
    expect(f).toEqual(cardEvent);
    expect(f.type).toBe("card");
    // Narrow reads mirror what the shell's renderCard touches.
    expect((f as { kind?: string }).kind).toBe("readonly");
    expect((f as { attention?: string }).attention).toBe("silent");
    expect((f as { source?: string }).source).toBe("bus");
    expect((f as { body?: { text: string } }).body).toEqual({
      text: '{"reason":"deep-link"}',
    });
  });
});

// --- cards-ux2 (02): blocking flag + card_send inbound validation ----------
describe("card frame blocking flag (cards-ux2 02)", () => {
  /** Shared full-field base (the 01 pin above minus `blocking`). */
  const base = {
    id: "card-9",
    kind: "readonly",
    title: "t",
    source: "bus",
    ts: 1739380000000,
    attention: "silent",
    body: { text: "x" },
  } as const;

  it("absent blocking stays assignable (modal default — compile-time pin)", () => {
    const frame: Extract<WebFrame, { type: "card" }> = { type: "card", ...base };
    expect(frame.blocking).toBeUndefined();
  });

  it("blocking:false (draft) and blocking:true (explicit modal) are assignable", () => {
    const draft: Extract<WebFrame, { type: "card" }> = { type: "card", ...base, blocking: false };
    const modal: Extract<WebFrame, { type: "card" }> = { type: "card", ...base, blocking: true };
    expect(draft.blocking).toBe(false);
    expect(modal.blocking).toBe(true);
  });

  it("toWebFrame forwards blocking 1:1 (no drop, none added)", () => {
    const f = toWebFrame({ type: "card", ...base, blocking: false });
    expect((f as { blocking?: boolean }).blocking).toBe(false);
    const absent = toWebFrame({ type: "card", ...base });
    expect((absent as { blocking?: boolean }).blocking).toBeUndefined();
  });
});

describe("validateCardSendExtra (cards-ux2 02 — mirrors card_answer's rules)", () => {
  it("accepts a good shape", () => {
    expect(validateCardSendExtra({ kind: "card_send", cardId: "c1", answers: { a: "1" } })).toEqual({
      kind: "card_send",
      cardId: "c1",
      answers: { a: "1" },
    });
  });

  it("accepts an empty answers object (vacuously all-string)", () => {
    expect(validateCardSendExtra({ kind: "card_send", cardId: "c1", answers: {} })?.cardId).toBe("c1");
  });

  it("rejects non-objects", () => {
    expect(validateCardSendExtra(null)).toBeNull();
    expect(validateCardSendExtra("card_send")).toBeNull();
  });

  it("rejects wrong/absent kind", () => {
    expect(validateCardSendExtra({ kind: "card_answer", cardId: "c1", answers: {} })).toBeNull();
    expect(validateCardSendExtra({ cardId: "c1", answers: {} })).toBeNull();
  });

  it("rejects empty or non-string cardId", () => {
    expect(validateCardSendExtra({ kind: "card_send", cardId: "", answers: {} })).toBeNull();
    expect(validateCardSendExtra({ kind: "card_send", cardId: 7, answers: {} })).toBeNull();
  });

  it("rejects answers that are null/array/non-string values (card_answer rules)", () => {
    expect(validateCardSendExtra({ kind: "card_send", cardId: "c1", answers: null })).toBeNull();
    expect(validateCardSendExtra({ kind: "card_send", cardId: "c1", answers: ["x"] })).toBeNull();
    expect(validateCardSendExtra({ kind: "card_send", cardId: "c1", answers: { a: 1 } })).toBeNull();
  });

  it("the appexec wrapper stays schema-loose (validateInbound accepts the frame)", () => {
    const frame = validateInbound({
      type: "appexec",
      extra: { kind: "card_send", cardId: "c1", answers: { a: "1" } },
    });
    expect(frame?.type).toBe("appexec");
  });
});
