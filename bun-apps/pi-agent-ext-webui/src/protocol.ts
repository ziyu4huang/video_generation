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

/** The full inbound command union (the authoritative wire schema, specs/04 §4). */
export const InboundCommandSchema = Type.Union([
  AgenticWithTextSchema,
  AbortCommandSchema,
  AppExecCommandSchema,
  ControlCommandSchema,
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
 * event-cards (02): one fill-in field of an interactive card body. `type`
 * "text" renders a text input (`placeholder` optional); "select" renders a
 * dropdown whose `options` are the choices. `name` keys the answer record
 * the browser posts back (`extra.answers` on the card_answer appexec frame).
 */
export interface CardField {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  placeholder?: string;
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
  // view-notifications (spec 01-B): a `webui:open` emission resolved to a
  // servable /files URL. `url` is PATH-ABSOLUTE (client joins
  // location.origin — encoding authority stays 100% server-side); `ts`
  // (epoch ms) lets the shell age-gate toasts so replayed/stale frames update
  // the panel but never re-toast. State-bearing: rides live broadcast AND the
  // connect-time replay (the wiring's store wrapper appends it to the
  // transcript ring like any outbound frame).
  | { type: "view_opened"; view?: string; title?: string; url: string; ts: number }
  // ask-user bridge (webui-present-adoption §C3): the core-task questionnaire
  // prompt mirrored to the shell (promptId correlates the answer). Replay-
  // eligible: rides live broadcast + the store-wrapped connect replay.
  | { type: "ask_user"; promptId: string; questions: unknown[]; ts: number }
  // ask-user tombstone (webui-tui-parity C1): the questionnaire resolved (or
  // exited early) — the shell retires its dialog. Replay ordering guarantees a
  // refreshed client renders ask_user then ask_user_done → no ghost.
  | { type: "ask_user_done"; promptId: string }
  // session info (webui-tui-parity C2): TUI-parity status — worktree + branch.
  // Replay-eligible so a refreshed tab knows which session it co-drives.
  | { type: "session_info"; cwd: string; branch?: string }
  // event-cards (01): the card frame — one primitive, three roles. v1 ships
  // the readonly projection: bus events snooped off the shared host bus
  // (source "bus") are summarized into `body.text` (plain text — the shell
  // renders it via textContent ONLY, never innerHTML). `id` is the deep-link
  // anchor (`#card-<id>`, ticket 03). Replay-eligible: the snoop broadcasts
  // through the SAME store-wrapped broadcaster, so connect-time snapshot
  // replay comes free.
  // event-cards (02): the body is discriminated BY KIND — readonly keeps
  // `{ text: string }` (01's pin, unchanged); interactive pins
  // `{ question, fields }` (the fill-in form card whose answers ride the
  // loose appexec channel back as extra.kind:"card_answer" and are
  // tombstoned by the `card_done` frame below); viewer (04) pins
  // `{ html: string }` — raw HTML rendered ONLY inside a
  // sandbox="allow-scripts" iframe srcdoc (NO allow-same-origin).
  | {
      type: "card";
      /** Wiring-generated (`card-${n}`, per-session counter) or a producer id (t05). */
      id: string;
      kind: "readonly";
      /** textContent-rendered ONLY — treat as untrusted. */
      title: string;
      /** "bus" (t01 snoop) | producer id (t05). */
      source: string;
      ts: number;
      attention: "view" | "input" | "silent";
      /** cards-ux2 (02): blocking mode. Absent/true = MODAL — the t02
       *  card_answer loop (first valid answer wins, the form retires on
       *  card_done). false = DRAFT — the card_send loop (submits post draft
       *  state into the session; the form stays live). */
      blocking?: boolean;
      /** readonly body: plain text (textContent-rendered) + optional deep-link
       * url rendered as a createElement anchor (event-cards 05, archify cards). */
      body: { text: string; url?: string };
    }
  | {
      type: "card";
      /** Same id space as the readonly member — the answer loop keys on it. */
      id: string;
      kind: "viewer";
      /** textContent-rendered ONLY — treat as untrusted. */
      title: string;
      /** Producer id (t05) — viewer cards are never snoop-generated. */
      source: string;
      ts: number;
      attention: "view" | "input" | "silent";
      /** cards-ux2 (02): blocking mode — see the readonly member (absent/true
       *  = modal; false = draft). */
      blocking?: boolean;
      /** viewer body (event-cards 04): raw HTML rendered ONLY inside a
       * sandbox="allow-scripts" iframe srcdoc — NO allow-same-origin, so the
       * frame gets an opaque origin and cannot touch the parent DOM or the
       * same-origin /ws + /api. The ONLY exit is the injected webui.emit
       * postMessage bridge, gated host-side by a confirm card. */
      body: { html: string };
    }
  | {
      type: "card";
      /** Same id space as the readonly member — the answer loop keys on it. */
      id: string;
      kind: "interactive";
      /** textContent-rendered ONLY — treat as untrusted. */
      title: string;
      /** Producer id (t05) — interactive cards are never snoop-generated. */
      source: string;
      ts: number;
      attention: "view" | "input" | "silent";
      /** cards-ux2 (02): blocking mode — see the readonly member (absent/true
       *  = modal; false = draft). */
      blocking?: boolean;
      /** interactive body: the question + fill-in fields (the form card). */
      body: { question: string; fields: CardField[] };
    }
  // event-cards (02): the card tombstone — an interactive card was answered
  // (FIRST-ANSWER-WINS, wiring-side exactly-once). Replay-eligible: rides the
  // same store-wrapped broadcaster as `card`, so a refreshed client replays
  // card then card_done IN ORDER and renders the answered state, never a
  // ghost form (same lesson as ask_user_done).
  | {
      type: "card_done";
      id: string;
      ts: number;
      /** cards-ux2 (04): the answers that retired the card (label -> value;
       *  null = skipped field) so a replayed session renders the answered
       *  state with content, not just a bare tombstone. Optional — older
       *  producers and non-form cards omit it. Outbound-only frame: no
       *  validator mirrors it (validateInbound covers ClientFrame only).
       */
      answers?: Array<{ label: string; answer: string | null }>;
    }
  // forward-compat: any other host event is forwarded generically (never thrown on)
  | { type: string; details?: unknown; [k: string]: unknown };

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
 * cards-ux2 (02): the `card_send` appexec extra payload — a NON-BLOCKING
 * (draft) card posted its collected state back to the host. Structural
 * sibling of the card_answer envelope (`{ kind, cardId, answers }` on the
 * same loose appexec channel); the DIFFERENCE is semantics: card_answer
 * resolves the MODAL answer loop (first valid answer wins, form retires on
 * card_done), card_send delivers DRAFT state into the agent session via the
 * wiring's sendMessage seam (the form stays live). Exported like the
 * card_answer envelope type — the host-side validator owns the sub-shape
 * (the wire schema stays loose by design, spec §6 forward-compat).
 */
export interface CardSendExtra {
  kind: "card_send";
  /** Non-empty string — mirrors card_answer's cardId rule. */
  cardId: string;
  /** field-name -> string, nothing else — mirrors card_answer's answers rule. */
  answers: Record<string, string>;
}

/**
 * Validate a card_send extra payload, or `null` if malformed. Mirrors the
 * card_answer validation EXACTLY (the same rules the wiring's
 * handleCardAnswer enforces inline): `kind` the "card_send" literal;
 * `cardId` a non-empty string; `answers` a non-null, non-array object whose
 * values are ALL strings. Never throws — the loose-channel contract
 * (invalid input is ignored, never errors).
 */
export function validateCardSendExtra(extra: unknown): CardSendExtra | null {
  if (typeof extra !== "object" || extra === null) return null;
  const e = extra as { kind?: unknown; cardId?: unknown; answers?: unknown };
  if (e.kind !== "card_send") return null;
  if (typeof e.cardId !== "string" || e.cardId === "") return null;
  if (typeof e.answers !== "object" || e.answers === null || Array.isArray(e.answers)) return null;
  for (const v of Object.values(e.answers)) {
    if (typeof v !== "string") return null; // answers: field-name -> string, nothing else
  }
  return { kind: "card_send", cardId: e.cardId, answers: e.answers as Record<string, string> };
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
