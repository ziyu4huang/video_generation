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
   * - `appexec` → `{ kind:"appexec", op }` with NO `source` field. This is the
   *   contract Task 3 branches on (`kind === "agentic"`) to bypass the mutex
   *   entirely (spec §6: appexec must NOT be routed through the input gate). v1
   *   defines no concrete appexec ops — this is a forward seam (spec §3).
   * - `subscribe` / `unsubscribe` → `{ kind:"control", op }`.
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
      case "appexec":
        // v1 forward seam: resolve `op` from the frame type and intentionally
        // DROP `extra` (no concrete ops/executor yet — see the appexec
        // DispatchAction variant in protocol.ts). A later ticket fills
        // execution; this seam MUST bypass the mutex gate (the wiring branches
        // on `kind === "agentic"` before gating).
        return { kind: "appexec", op: frame.type };
      case "subscribe":
      case "unsubscribe":
        return { kind: "control", op: frame.type };
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
