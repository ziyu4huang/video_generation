/**
 * protocol.ts — the schema layer for the web wire protocol (specs/04 §4).
 *
 * TypeBox schemas (both directions) + a pure outbound frame-builder. This is the
 * foundation the deep module (`web-transport.ts`, Task 1) and the wiring
 * (`extensions/webui.ts`, Task 3) build on: schema-derived types + a pure mapper.
 *
 * Purity invariant: NO I/O, NO `bun`, NO runtime `@earendil-works/pi-coding-agent`.
 * The reachable `ExtensionEvent` union is mirrored here as a structural
 * {@link EventLike} so the SDK type is a type-only reference that erases at
 * compile time (spec §3) — this keeps the schema layer fully testable in
 * isolation and preserves the Path-B migration seam.
 *
 * Validation stance: TypeBox (ecosystem standard — `pi-agent-cli` declares
 * `"typebox": "^1.3.7"`). The import specifier is `"typebox"` (the v1.x package
 * name — NOT legacy `@sinclair/typebox`).
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { BtwCommand, BtwEvent } from "./btw-channels.js";
// Type-only: session-store imports WebFrame (also type-only) — no runtime cycle.
import type { SessionSnapshot } from "./session-store.js";

// --- Inbound commands (client -> server), specs/04 §4 "Inbound commands" ---

/**
 * Agentic commands that carry a text payload and route THROUGH the mutex gate:
 * prompt / steer / followUp (steer/followUp map to `sendUserMessage` deliverAs).
 * `minLength: 1` (architecture v2 §3.4): an empty prompt would otherwise reach
 * `sendUserMessage("")` — a no-op at best, a confusing empty turn at worst.
 */
const AgenticWithTextSchema = Type.Union([
  Type.Object({ type: Type.Literal("prompt"), text: Type.String({ minLength: 1 }) }),
  Type.Object({ type: Type.Literal("steer"), text: Type.String({ minLength: 1 }) }),
  Type.Object({ type: Type.Literal("followUp"), text: Type.String({ minLength: 1 }) }),
]);

/** `abort` is agentic (routes to `ctx.abort()`) but carries no text. */
const AbortCommandSchema = Type.Object({ type: Type.Literal("abort") });

/**
 * `appexec` is the HITL return transport (spec Component 1): it BYPASSES the
 * mutex entirely. The optional `extra` bag carries a concrete op; Phase 1
 * recognizes `{ kind: "respond", id, action, tweak? }`. The SCHEMA stays loose
 * (an unknown-op frame must still VALIDATE here so it can be IGNORED at parse
 * time — never rejected by the schema, spec §6 forward-compat). The
 * `{ type: "appexec" }` shape alone must validate.
 */
const AppExecCommandSchema = Type.Object({
  type: Type.Literal("appexec"),
  extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** Control commands (subscribe / unsubscribe) — v1 no-op beyond WS bookkeeping. */
const ControlCommandSchema = Type.Union([
  Type.Object({ type: Type.Literal("subscribe") }),
  Type.Object({ type: Type.Literal("unsubscribe") }),
]);

/**
 * `btw` is the side-panel transport (Task 6): a validated command frame for the
 * btw thread. Like `appexec`, the SCHEMA stays loose (optional payloads, no
 * cross-field consistency) — an inconsistent body (e.g. `ask` without `text`)
 * still VALIDATES here so it can be IGNORED at parse time via
 * `btwCommandFromFrame` (never rejected by the schema, spec §6 forward-compat).
 */
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
        // Full BtwThinkingLevel (architecture v2 §3.4): v1 admitted only
        // off|low|medium|high, so the panel's minimal/xhigh/max selections were
        // silently dropped by validateInbound. Keep in sync with
        // btw-channels.ts BtwThinkingLevel (7 values, pi-ai 0.84.2 surface).
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ]),
  ),
});
export type BtwCommandFrame = Static<typeof BtwCommandFrameSchema>;

/** The full inbound command union (the authoritative wire schema, specs/04 §4). */
export const InboundCommandSchema = Type.Union([
  AgenticWithTextSchema,
  AbortCommandSchema,
  AppExecCommandSchema,
  ControlCommandSchema,
  BtwCommandFrameSchema,
]);

/** Inbound frame as validated by {@link validateInbound}. */
export type ClientFrame = Static<typeof InboundCommandSchema>;

// --- Outbound frames (server -> client), specs/04 §4 "Outbound frames" ---

/**
 * Structural, type-only mirror of the reachable `ExtensionEvent` set (ticket 01).
 * The SDK `ExtensionEvent` union is NEVER imported at runtime — this shape is
 * what {@link toWebFrame} actually inspects, so the module stays I/O- and
 * pi-free and the reference erases at compile time.
 */
export interface EventLike {
  type: string;
  toolName?: string;
  details?: unknown;
  [k: string]: unknown;
}

/**
 * Outbound frame union. Known event types are enumerated (so the frontend can
 * exhaustively switch on `.type`); a final forward-compat member lets unknown
 * host events pass through verbatim (spec §6 — malformed/unknown never throws).
 *
 * v2 (architecture v2 §3.4): known members declare their common payload fields
 * (`text` on message_*, `details` on tool_*) instead of hiding everything
 * behind the generic member — `toWebFrame` spreads the host event intact, so
 * these are the fields the frontend can read WITHOUT a cast; any extra fields
 * still ride the spread (and remain reachable via the forward-compat member).
 */
export type WebFrame =
  // agent stream — forwarded from pi.on (message_update carries a text delta)
  | { type: "message_start" | "message_update" | "message_end"; text?: string; details?: unknown }
  | {
      type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
      toolName: string;
      details?: unknown;
    }
  | { type: "tool_result"; details?: unknown }
  | { type: "turn_start" | "turn_end" }
  | { type: "agent_settled" }
  | { type: "session_before_compact" | "session_compact" }
  // v2: the typed error reply (e.g. {type:"error",reason:"no_session"} from the
  // wiring's no-session guard) — was previously only reachable via the generic
  // forward-compat member.
  | { type: "error"; reason: string }
  // v2: connect-time session snapshot (architecture v2 §3.3) — sent to each WS
  // client on open so a mid-session open / refresh sees the agent history
  // (bounded transcript + current presentation + mutex driver).
  | { type: "snapshot"; state: SessionSnapshot }
  // mutex signals — produced by the MutexNotifier impl (spec §3)
  | { type: "mutex_blocked"; blocked: "web" | "tui"; by: "tui" | "web" }
  | { type: "mutex_force_release"; driver: "web" | "tui" }
  // btw side-panel — thread state snapshots / notices (Task 6)
  | BtwWebFrame
  // view-notifications (spec 01-B): a `webui:open` emission resolved to a
  // servable /files URL. `url` is PATH-ABSOLUTE (client joins
  // location.origin — encoding authority stays 100% server-side); `ts`
  // (epoch ms) lets the shell age-gate toasts so replayed/stale frames update
  // the panel but never re-toast. State-bearing: rides live broadcast AND the
  // connect-time replay (the wiring's store wrapper appends it to the
  // transcript ring like any outbound frame).
  | { type: "view_opened"; view?: string; title?: string; url: string; ts: number }
  // forward-compat: any other host event is forwarded generically (never thrown on)
  | { type: string; details?: unknown; [k: string]: unknown };

/** Outbound btw frame: a thread snapshot or notice (see `BtwEvent`, Task 5). */
export interface BtwWebFrame {
  type: "btw";
  event: BtwEvent;
}

// --- DispatchAction (the descriptor parseCommand returns), specs/04 §3 ---

/**
 * The dispatch descriptor `WebTransport.parseCommand` resolves an inbound frame
 * to (consumed by Task 1). `agentic` routes THROUGH the mutex; `appexec`
 * BYPASSES it; `control` is a v1 no-op. `source: "extension"` marks the agentic
 * path so the wiring gates via `MutexController.handleInput("extension")`.
 */
export type DispatchAction =
  | {
      kind: "agentic";
      op: "prompt" | "steer" | "followUp" | "abort";
      text?: string;
      source: "extension";
    }
  /**
   * `appexec` BYPASSES the mutex entirely. Phase 1 surfaces exactly one op —
   * `respond` — the HITL response a browser posts back for a pending
   * presentation (`{ kind:"respond", id, action, tweak? }` carried in `extra`).
   * {@link WebTransport.parseCommand} validates the respond sub-shape and
   * resolves THIS descriptor; an unknown op or a malformed respond resolves to
   * `null` (ignored at parse time, NOT rejected by the schema — spec §6). The
   * `op:"respond"` literal lets the wiring narrow `action.id` / `action.action`
   * / `action.tweak` without an `as`. v2 adds the `cancel` op (architecture v2
   * §3.4): `{ kind:"cancel", id }` resolves the ONE pending under `id` as
   * {cancelled:true} — the browser's "Cancel" button, without dropping the WS
   * (which would abort EVERY pending and force a re-present). Future ops add
   * union members here.
   */
  | {
      kind: "appexec";
      op: "respond";
      id: string;
      action: string;
      tweak?: string;
    }
  | { kind: "appexec"; op: "cancel"; id: string }
  | { kind: "control"; op: "subscribe" | "unsubscribe" }
  /**
   * `btw` is the side-panel command path (Task 6): the wiring forwards the
   * command to the btw thread over the event bus — it is NOT agentic, so it
   * must NOT acquire the mutex. An inconsistent body resolves to `null`
   * (ignored at parse time, spec §6).
   */
  | { kind: "btw"; command: BtwCommand };

// --- Pure helpers ---

/**
 * Schema-validate a parsed JSON value into a typed {@link ClientFrame}, or
 * `null` if it is not a valid inbound command. Never throws — invalid input
 * (non-objects, unknown discriminator, missing/non-string `text`) returns null
 * (spec §6: malformed inbound is ignored, never crashes, never acquires a lock).
 */
export function validateInbound(raw: unknown): ClientFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  return Value.Check(InboundCommandSchema, raw) ? (raw as ClientFrame) : null;
}

/**
 * Map a structural host event to an outbound {@link WebFrame}, forwarding every
 * field the event carries intact (`.details` / `.toolName` / any extras).
 *
 * Fidelity is deliberate (spec §2: `tool_result` / `tool_execution_*` carry
 * typed `.details` that tickets 05/06 render): we spread the event rather than
 * enumerate/whitelist fields, so nothing is dropped. The forward-compat path
 * (unknown `type`) also forwards verbatim and never throws (spec §6).
 */
export function toWebFrame(event: EventLike): WebFrame {
  const { type, ...rest } = event;
  return { type, ...rest } as WebFrame;
}
