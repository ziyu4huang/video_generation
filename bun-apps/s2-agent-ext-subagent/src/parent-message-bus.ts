/**
 * ParentMessageBus — the child→parent half of send_message (agent-teams parity
 * ticket 02, effort `.planning/2026-08-22-subagent-teams-parity`).
 *
 * Children are IN-PROCESS sessions with no direct channel to their parent's
 * turn loop (pi has no custom-message handler API), so a child's
 * `send_message {to:"main"}` routes through this process-singleton bus. The
 * extension entry wires the deliverer once at load with
 * `pi.sendMessage(<CustomMessage>, {deliverAs:"followUp", triggerTurn:true})`
 * — the SAME wake seam wireBackgroundDeliverer proved (PR #1800): followUp
 * alone only appends; triggerTurn is what wakes an IDLE parent into a turn.
 *
 * Delivery is best-effort and silent on failure, mirroring the background
 * deliverer: an unwired host (no sendMessage) gets publish() → {ok:false} and
 * the child sees an actionable error, never a crash.
 */

/** Who the message is from — the live-agent identity the parent sees. */
export interface ParentMessageFrom {
  /** Live-agent handle ("researcher") or another addressing the parent knows. */
  name: string;
  /** The live agent's stable id (first exchange's toolCallId), when known. */
  agentId?: string;
}

export function formatAgentMessage(from: ParentMessageFrom, message: string): string {
  return [
    "<agent-message>",
    `Message from live agent "${from.name}"${from.agentId ? ` (agentId ${from.agentId})` : ""}:`,
    message,
    "</agent-message>",
  ].join("\n");
}

export class ParentMessageBus {
  private deliverer: ((msg: string) => void) | undefined;

  /** Wired by the extension entry via wireParentMessageDeliverer. Undefined = no parent wake in this host. */
  setDeliverer(fn: ((msg: string) => void) | undefined): void {
    this.deliverer = fn;
  }

  /**
   * Deliver a child's message to the parent session. Returns ok, or an error
   * the child can act on when no deliverer is wired (detached/test hosts).
   */
  publish(from: ParentMessageFrom, message: string): { ok: true } | { ok: false; error: string } {
    if (!this.deliverer) {
      return {
        ok: false,
        error:
          "the parent message bus is not wired in this host (no sendMessage) — the parent will not receive this. " +
          "Return your answer in this exchange's normal output instead.",
      };
    }
    try {
      this.deliverer(formatAgentMessage(from, message));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `delivery to the parent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

let singleton: ParentMessageBus | undefined;

/** Process-wide singleton — children and the extension entry must share ONE bus. */
export function getParentMessageBus(): ParentMessageBus {
  singleton ??= new ParentMessageBus();
  return singleton;
}

/**
 * Wire the singleton's deliverer to a pi-like sender. The message string is
 * wrapped in a CustomMessage (`customType: "subagent-agent-message"`,
 * `display: true`) and sent followUp + triggerTurn — the one proven wake seam
 * (see wireBackgroundDeliverer for the full why; sendMessage takes a message
 * OBJECT, not a raw string). Best-effort: a host without sendMessage degrades
 * to publish() → {ok:false}.
 */
export function wireParentMessageDeliverer(
  pi: {
    sendMessage?: (
      message: { customType: string; content: string; display: boolean },
      opts?: { deliverAs?: "followUp" | "nextTurn" | "steer"; triggerTurn?: boolean },
    ) => void;
  },
  bus: ParentMessageBus = getParentMessageBus(),
): void {
  try {
    bus.setDeliverer((msg) =>
      pi.sendMessage?.(
        { customType: "subagent-agent-message", content: msg, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  } catch {
    // best-effort only
  }
}
