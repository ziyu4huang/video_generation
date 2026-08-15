/**
 * web-transport.ts — the pure deep module for the web wire protocol (specs/04 §3).
 *
 * Owns exactly two pure methods:
 *  - {@link WebTransport.parseCommand}: the inbound dispatch DECISION. It resolves
 *    a validated {@link ClientFrame} to a {@link DispatchAction} DESCRIPTOR
 *    (agentic vs appexec-bypass vs control). It does NOT drive pi, does NOT touch
 *    the MutexController, performs NO I/O — the op->pi-call resolution (spec §3
 *    table) is the extension entry's job (Task 3, `extensions/webui.ts`), executed
 *    only AFTER the mutex gate returns "continue".
 *  - {@link WebTransport.mapEvent}: the outbound event->frame MAPPING. A thin
 *    delegation to {@link toWebFrame}; the deep module earns its depth via
 *    parseCommand + the consolidated type table (spec §3 deletion test).
 *
 * Purity is non-negotiable and is the Path-B migration guarantee: this module is
 * fully testable through its interface with no live session. It has ZERO runtime
 * pi/Bun imports — the only import is the pure schema layer (`./protocol.js`);
 * `EventLike` is the structural, type-only mirror of the reachable ExtensionEvent
 * set, so it erases at compile time (spec §3).
 *
 * op -> pi-call resolution table (spec §3), executed in Task 3, NOT here:
 *   prompt   -> inject the text as a user message
 *   steer    -> inject the text as a user message, delivered as a steer
 *   followUp -> inject the text as a user message, delivered as a follow-up
 *   abort    -> ask the context to abort the in-flight turn
 */
import {
  toWebFrame,
  type ClientFrame,
  type DispatchAction,
  type EventLike,
  type WebFrame,
} from "./protocol.js";
import { btwCommandFromFrame } from "./btw-channels.js";

export class WebTransport {
  /**
   * Inbound: classify a validated {@link ClientFrame} into a
   * {@link DispatchAction} descriptor.
   *
   * - agentic (`prompt` / `steer` / `followUp` / `abort`) → `{ kind:"agentic",
   *   op, text?, source:"extension" }`. The `source:"extension"` is baked in here
   *   because ALL inbound web agentic commands gate as `"extension"` (spec §1, §6)
   *   — Task 3 passes it straight to the mutex controller's input gate
   *   (`"extension"`) without having to know the web's source identity.
   * - `appexec` → `{ kind:"appexec", op:"respond", id, action, tweak? }` with
   *   NO `source` field. This is the contract the wiring branches on
   *   (`kind === "agentic"`) to bypass the mutex entirely (spec §6: appexec
   *   must NOT be routed through the input gate). `respond` is the HITL return
   *   transport (spec Component 1, shipped in Phase 1): it resolves the pending
   *   Promise registered under `id`. An unknown op or a malformed respond
   *   resolves to `null` (ignored — spec §6 forward-compat).
   * - `subscribe` / `unsubscribe` → `{ kind:"control", op }`.
   * - `btw` → `{ kind:"btw", command }` (Task 6): the side-panel command path.
   *   The validated frame body is narrowed via `btwCommandFromFrame`; an
   *   inconsistent body (e.g. `ask` without text) → `null` (ignored — the schema
   *   stays loose so such frames still VALIDATE, spec §6). NOT agentic: the
   *   wiring must NOT route it through the mutex gate.
   * - unknown type → `null` (defensive). A ClientFrame is a closed, validated
   *   union so this is unreachable for well-typed input; but an unknown type must
   *   never be silently mis-routed through agentic (which would spuriously acquire
   *   the lock) or appexec. Malformed raw input is rejected earlier by
   *   {@link validateInbound} (protocol.ts); this is the defensive tail.
   */
  parseCommand(frame: ClientFrame): DispatchAction | null {
    switch (frame.type) {
      case "prompt":
      case "steer":
      case "followUp":
        return { kind: "agentic", op: frame.type, text: frame.text, source: "extension" };
      case "abort":
        return { kind: "agentic", op: "abort", source: "extension" };
      case "appexec": {
        // HITL return transport (spec Component 1): validate the respond
        // sub-shape in `extra` and surface a typed descriptor. v2 also
        // recognizes `{ kind:"cancel", id }` — the browser's "Cancel" button
        // (architecture v2 §3.4). Unknown op or malformed sub-shape -> null
        // (IGNORED at parse time; the schema stays loose so such frames still
        // VALIDATE, spec §6). This seam MUST bypass the mutex gate (the wiring
        // branches on `kind === "agentic"` first).
        const extra = frame.extra;
        if (
          extra?.kind === "respond" &&
          typeof extra.id === "string" &&
          typeof extra.action === "string" &&
          (extra.tweak === undefined || typeof extra.tweak === "string")
        ) {
          const out: {
            kind: "appexec";
            op: "respond";
            id: string;
            action: string;
            tweak?: string;
          } = { kind: "appexec", op: "respond", id: extra.id, action: extra.action };
          if (typeof extra.tweak === "string") out.tweak = extra.tweak;
          return out;
        }
        if (extra?.kind === "cancel" && typeof extra.id === "string") {
          return { kind: "appexec", op: "cancel", id: extra.id };
        }
        return null;
      }
      case "subscribe":
      case "unsubscribe":
        return { kind: "control", op: frame.type };
      case "btw": {
        // Side-panel command path (Task 6): narrow the loose-but-validated body
        // to a BtwCommand; inconsistent bodies are IGNORED here (null), never
        // rejected by the schema (spec §6). Bypasses the mutex (not agentic).
        const command = btwCommandFromFrame(frame);
        if (!command) return null;
        return { kind: "btw", command };
      }
      default:
        // Unreachable for a valid ClientFrame (closed union). Defensive: never
        // mis-route an unknown type through any gate (spec §6).
        return null;
    }
  }

  /**
   * Outbound: map a host event to a {@link WebFrame}, forwarding `.details` /
   * `.toolName` / any extras intact. Delegates to {@link toWebFrame} so the
   * frame-building logic lives in exactly one place (the schema layer).
   */
  mapEvent(event: EventLike): WebFrame {
    return toWebFrame(event);
  }
}
