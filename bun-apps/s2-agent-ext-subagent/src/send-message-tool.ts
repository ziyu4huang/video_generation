/**
 * `send_message` tool — follow-up messaging for named live agents
 * (agent-teams parity ticket 02, effort `.planning/2026-08-22-subagent-teams-parity`).
 *
 * The parent addresses a live agent by `name` or `agentId`: a mid-flight agent
 * is STEERED (the message joins its current exchange; no separate reply), an
 * idle agent is re-prompted — awaited by default, or fire-and-forget with
 * `wait:false` (the reply arrives as a <task-notification> through the
 * BackgroundRunManager deliverer). A child addresses `to:"main"` through the
 * process-singleton ParentMessageBus — the one child→parent wake seam.
 *
 * Routing, not dispatch: the tool resolves against the live registry
 * (getLiveAgentRegistry) and hands off to LiveAgent.send, which owns the
 * exchange semantics (per-exchange timeoutMs, lifetime-aggregate guards).
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveAgentRegistry, LiveAgentSendResult, PendingProtocolMap } from "@repo/s2-agent-core-runtime";
import { getLiveAgentRegistry, getPendingProtocolMap } from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";
import { getBackgroundRunManager } from "./background-run-manager.js";
import type { ParentMessageBus } from "./parent-message-bus.js";
import { getParentMessageBus } from "./parent-message-bus.js";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  formatPlanApprovalRequestNotification,
  formatShutdownRequestNotification,
  isDetachedResumeHost,
  SHUTDOWN_WRAP_UP_MESSAGE,
} from "./protocol-format.js";
import { DEFAULT_TIMEOUT_MS } from "./subagent-tool-schema.js";

export const sendMessageToolSchema = Type.Object({
  to: Type.String({
    description:
      "Target: a live agent's `name` or `agentId` (from spawn_subagent `name`), or 'main' to address the ROOT session (a CHILD reporting up; a nested child's 'main' is the root, not its intermediate parent — the bus is process-global). From a named child, a teammate target is parent-brokered: delivered to the teammate AND surfaced to the parent.",
  }),
  message: Type.String({
    description:
      "The message text. Self-contained — a follow-up exchange, not a new task. With a protocol `type`, this carries the payload (e.g. the plan for plan_approval_request, the reason for shutdown_request).",
  }),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("shutdown_request"),
        Type.Literal("shutdown_response"),
        Type.Literal("plan_approval_request"),
        Type.Literal("plan_approval_response"),
      ],
      {
        description:
          "Protocol envelope (ticket 04). shutdown_request: parent→child = two-stage stop (wrap-up turn, then grace-abort); child→main = notification (parent approves by stopping). plan_approval_response: parent→child resolves a pending request_plan_approval (approve:true|false, optional feedback). plan_approval_request: child→main notifies (for agents without the injected tool). shutdown_response: acknowledgment, either direction.",
      },
    ),
  ),
  approve: Type.Optional(
    Type.Boolean({
      description:
        "plan_approval_response only: the verdict. true = approved, false = denied. Required for plan_approval_response.",
    }),
  ),
  feedback: Type.Optional(
    Type.String({
      description: "Optional guidance returned with a plan_approval_response or a shutdown_response.",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Block until the agent replies (default true). false returns immediately; the reply arrives as a <task-notification> follow-up.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Per-exchange wall-clock cap in ms for the awaited reply (default 15 min); for shutdown_request, the grace window before the hard stop (default 60s).",
    }),
  ),
  from: Type.Optional(
    Type.String({
      description:
        "With to:'main' — your own live-agent name, so the parent knows who is reporting. Ignored for agent targets.",
    }),
  ),
});

export interface SendMessageToolOptions {
  /** Live-agent registry the parent-side routing resolves against. Defaults to the core-runtime singleton. */
  liveRegistry?: LiveAgentRegistry;
  /** Child→parent bus for to:'main'. Defaults to the process singleton. */
  bus?: ParentMessageBus;
  /** Pending-protocol map plan_approval_response resolves against. Defaults to the core-runtime singleton. */
  pending?: PendingProtocolMap;
  /** Raw notification deliverer for wait:false replies (BackgroundRunManager.deliver). Defaults to the singleton. */
  background?: { deliver(message: string): void };
  /** Injectable for tests (defaults to process.env — the detached-resume refusal reads it). */
  env?: Record<string, string | undefined>;
  /**
   * Sender identity (team addressing, ticket 05): set on the per-child instance
   * a NAMED child receives (buildSpawnOptions stamps it at spawn time). When
   * set, this instance runs INSIDE that child: sibling targets route
   * parent-brokered (never direct — spec §3), protocol envelopes aimed at
   * teammates refuse, and `to:'main'` identity defaults to this name.
   * Undefined = the parent's shared instance (unmodified ticket-02 behavior).
   */
  selfName?: string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Terminal lifetime failure — the agent can never exchange again, so it leaves the roster (records survive, keyed by agentId). */
function isTerminal(failure: NonNullable<LiveAgentSendResult["failure"]>): boolean {
  return failure.kind === "budget" || failure.kind === "turns";
}

/**
 * Reply budget for the wait:false notification. Generous (the parent asked
 * for this reply and has nowhere else to fetch it — follow-up exchanges are
 * not persisted), but bounded so several landing together can't flood the
 * parent context.
 */
const REPLY_CHARS = 4000;

/**
 * Purpose-built wait:false notification. NOT formatTaskNotification: that
 * trailer's "Full output: list_subagent_runs get id <agentId>" points at the
 * FIRST exchange's record (follow-up exchanges write no records), so reusing
 * it would hand the parent the wrong output as if it were the reply. The
 * reply is inlined instead; a truncation marker tells the parent to ask the
 * agent to re-send the tail.
 */
export function formatReplyNotification(
  spec: { name: string; agentId: string; model?: string },
  result: LiveAgentSendResult,
): string {
  const body = result.failure ? `${result.failure.kind}: ${result.failure.message}` : result.output || "(no output)";
  const preview =
    body.length > REPLY_CHARS
      ? `${body.slice(0, REPLY_CHARS)}\n[truncated — ask "${spec.name}" to re-send the remainder]`
      : body;
  return [
    "<task-notification>",
    `send_message reply from live agent "${spec.name}" (agentId ${spec.agentId}, model ${spec.model ?? "default"}).`,
    `- status: ${result.failure ? result.failure.kind : "done"}`,
    "- reply:",
    preview,
    "</task-notification>",
  ].join("\n");
}

/**
 * Preview cap for sibling relays surfaced to the parent (ticket 05). Tighter
 * than a reply's — the parent did not ask for this traffic, it is observing
 * team coordination — but generous enough that short handoffs read whole.
 */
const RELAY_CHARS = 2000;

function relayPreview(message: string): string {
  return message.length > RELAY_CHARS
    ? `${message.slice(0, RELAY_CHARS)}\n[truncated relay — ask the sender to re-send the remainder]`
    : message;
}

/**
 * Ticket 05 — the parent-side surface of a brokered sibling send. The body the
 * ParentMessageBus wraps (its deliverer adds the `<agent-message>` envelope):
 * `from → to`, the capped message preview. The sender knows what it sent; the
 * TARGET sees it as its next input; this is what lets the PARENT see the team
 * talking — both sides see it, per spec §3.
 */
export function formatSiblingRelayNotification(from: string, to: string, message: string): string {
  return [`Teammate relay "${from}" → "${to}":`, relayPreview(message)].join("\n");
}

/**
 * Ticket 05 — a brokered exchange's reply, published to the parent when the
 * target's fire-and-forget exchange settles. Same body shape as the relay so
 * the parent reads ONE conversation, not two formats.
 */
export function formatSiblingReplyNotification(from: string, to: string, result: LiveAgentSendResult): string {
  const body = result.failure ? `${result.failure.kind}: ${result.failure.message}` : result.output || "(no output)";
  return [
    `Teammate reply "${from}" → "${to}" (${result.failure ? result.failure.kind : "done"}):`,
    relayPreview(body),
  ].join("\n");
}

export function createSendMessageTool(
  options: SendMessageToolOptions = {},
): ToolDefinition<typeof sendMessageToolSchema, undefined> {
  const liveRegistry = options.liveRegistry ?? getLiveAgentRegistry();
  const bus = options.bus ?? getParentMessageBus();
  const pending = options.pending ?? getPendingProtocolMap();
  const background = options.background ?? getBackgroundRunManager();
  const detached = isDetachedResumeHost(options.env);
  // Named-child identity (ticket 05). The `from` a child publishes under
  // defaults to it — self-declared `from` still wins for hosts that stamp
  // nothing, so the ticket-02 surface is unchanged for unnamed children.
  const selfName = options.selfName?.trim() || undefined;
  const childIdentity = (declared?: string) => declared?.trim() || selfName || "child";

  /**
   * Protocol envelopes (ticket 04). In-process only: a detached resume
   * subprocess's parent lives in another OS process, so child-origin protocol
   * messages refuse rather than talk to a bus nobody reads.
   */
  const executeProtocol = async (
    params: {
      to: string;
      message: string;
      type: "shutdown_request" | "shutdown_response" | "plan_approval_request" | "plan_approval_response";
      approve?: boolean;
      feedback?: string;
      timeoutMs?: number;
      from?: string;
    },
    signal: AbortSignal | undefined,
  ) => {
    const childOrigin = params.to === "main";
    if (childOrigin && detached) {
      return textResult(
        `send_message ${params.type} to 'main' is unavailable in a detached resume subprocess — the parent session lives in another process. Finish your run and write the outcome to disk instead.`,
      );
    }
    // Team addressing (ticket 05): protocol envelopes are parent↔child only.
    // A named child steering one at a TEAMMATE would command parent-grade
    // levers — two-stage stop, verdict resolution — with no parent in the
    // loop. Refused; teammate coordination is a plain brokered message.
    if (selfName && !childOrigin) {
      return textResult(
        `send_message ${params.type} addresses the parent ('main') or is issued by it — never a teammate. ` +
          "Address a teammate with a PLAIN send_message (the parent brokers and sees it); lifecycle and approvals stay with the parent.",
      );
    }
    switch (params.type) {
      case "plan_approval_response": {
        if (params.approve === undefined) {
          return textResult(
            "plan_approval_response requires an explicit verdict: add approve: true|false (plus optional feedback).",
          );
        }
        if (childOrigin) {
          return textResult(
            "plan_approval_response addresses the AGENT whose plan is pending (a child answers the parent, never the reverse). " +
              'Use to: "<agent name>".',
          );
        }
        const entry = liveRegistry.get(params.to);
        const key = entry ? entry.name : params.to;
        const responded = pending.respond(key, { approved: params.approve, feedback: params.feedback });
        return responded
          ? textResult(
              `Verdict delivered to "${key}" — its pending request_plan_approval resolves ${params.approve ? "APPROVED" : "DENIED"}${params.feedback ? ` (feedback: ${params.feedback})` : ""}.`,
            )
          : textResult(
              `No pending plan approval from "${key}". Pending: ${pending.pendingNames().join(", ") || "(none)"}. ` +
                "The agent may have timed out (default-deny) or never asked.",
            );
      }
      case "plan_approval_request": {
        if (!childOrigin) {
          return textResult(
            "plan_approval_request is child→parent only. The parent asks a child to revise via a normal message, or waits for the child's own request_plan_approval tool call.",
          );
        }
        const name = childIdentity(params.from);
        const published = bus.publish({ name }, formatPlanApprovalRequestNotification({ name }, params.message));
        if (!published.ok) return textResult(`send_message to main failed: ${published.error}`);
        return textResult(
          `Plan-approval request delivered to the parent session (from "${name}"). ` +
            "It arrives as a follow-up; the parent replies with a PLAIN send_message stating the verdict, " +
            "which reaches you as your next message — continue once you see it. " +
            "(If you have the request_plan_approval tool, prefer it: it blocks for the verdict instead.)",
        );
      }
      case "shutdown_request": {
        if (childOrigin) {
          const name = childIdentity(params.from);
          const published = bus.publish({ name }, formatShutdownRequestNotification({ name }, params.message));
          if (!published.ok) return textResult(`send_message to main failed: ${published.error}`);
          return textResult(
            `Shutdown request delivered to the parent session (from "${name}") — notification only, the parent approves by stopping you. ` +
              "Keep your state written to disk; expect either a wrap-up steer or a stop.",
          );
        }
        return shutdownRequest(params, signal);
      }
      case "shutdown_response": {
        const composed = [
          "shutdown_response (acknowledgment):",
          params.message,
          params.feedback ? `Feedback note: ${params.feedback}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        if (childOrigin) {
          const name = childIdentity(params.from);
          const published = bus.publish({ name }, composed);
          if (!published.ok) return textResult(`send_message to main failed: ${published.error}`);
          return textResult(`Shutdown acknowledgment delivered to the parent session (from "${name}").`);
        }
        const entry = liveRegistry.get(params.to);
        if (!entry) {
          return textResult(
            `No live agent "${params.to}". Live agents: ${liveRegistry.names().join(", ") || "(none)"}.`,
          );
        }
        liveRegistry.touch(entry.name);
        const result = await entry.agent.send(composed, { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal });
        return textResult(
          result.steered
            ? `Delivered to "${entry.name}" — mid-exchange, so it steers into the current run.`
            : result.failure
              ? `Exchange with "${entry.name}" did not complete (${result.failure.kind}): ${result.failure.message}.`
              : result.output || `("${entry.name}" returned an empty reply.)`,
        );
      }
    }
  };

  /**
   * Parent→child shutdown_request — two-stage, mirroring the budget guard's
   * BUDGET_WRAP_UP_MESSAGE semantics (agent-budget.ts): stage 1 delivers the
   * wrap-up notice (steer when mid-flight, final prompt when idle) bounded by
   * the grace window; stage 2 stops the session (release disposes → aborts any
   * in-flight exchange). One exchange per request: the same grace window caps
   * both the prompt path and the backstop timer, so there is exactly one
   * abort lever per shutdown.
   */
  const shutdownRequest = async (
    params: { to: string; message?: string; timeoutMs?: number },
    signal: AbortSignal | undefined,
  ) => {
    const entry = liveRegistry.get(params.to);
    if (!entry) {
      return textResult(`No live agent "${params.to}". Live agents: ${liveRegistry.names().join(", ") || "(none)"}.`);
    }
    liveRegistry.touch(entry.name);
    const graceMs = params.timeoutMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    // The caller's stated reason rides the wrap-up notice (review m1) — the
    // child's model sees WHY on its final turn, not just the generic text.
    const notice = [
      SHUTDOWN_WRAP_UP_MESSAGE,
      params.message?.trim() ? `Shutdown reason from the parent: ${params.message.trim()}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    // Stage 2 backstop — the ONLY abort for the steered case (send returned
    // immediately; the running exchange would otherwise outlive the request).
    // Cleared when the wrap-up exchange completes on its own first.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => liveRegistry.release(entry.name, "shutdown-request");
    // A pre-aborted calling turn skips the shutdown ENTIRELY without touching
    // the agent (review m2): a whole-turn Esc must not dispose a persistent
    // named agent (turn-abort decoupling, ADR-subagent-0007) — the parent can
    // re-issue the request in its next turn.
    if (signal?.aborted) {
      return textResult(
        `Shutdown of "${entry.name}" skipped — the calling turn aborted before delivery. The agent is untouched and still on the live roster; re-issue the request in a later turn.`,
      );
    }
    graceTimer = setTimeout(stop, graceMs);
    try {
      const result = await entry.agent.send(notice, { timeoutMs: graceMs, label: "shutdown" });
      // Steered: send returned immediately (the exchange is still running) —
      // the grace timer stays armed as stage 2; stopping here would kill the
      // wrap-up turn we just asked for.
      if (result.steered) {
        return textResult(
          `Shutdown request delivered to "${entry.name}" — steered into its current exchange. It gets ${Math.round(graceMs / 1000)}s of grace to wrap up, then its session is stopped and removed from the live roster.`,
        );
      }
      clearTimeout(graceTimer);
      stop();
      if (result.failure) {
        return textResult(
          `Shutdown of "${entry.name}": wrap-up exchange ended ${result.failure.kind} (${result.failure.message}); the session is stopped and off the live roster. Run records survive (agentId ${entry.agentId}).`,
        );
      }
      return textResult(
        `"${entry.name}" wrapped up and is stopped (removed from the live roster; records survive, keyed by agentId ${entry.agentId}).` +
          (result.output ? ` Final pointer: ${result.output.slice(0, 500)}` : ""),
      );
    } catch {
      clearTimeout(graceTimer);
      stop();
      return textResult(
        `Shutdown of "${entry.name}": the wrap-up exchange threw; the session is stopped and off the live roster.`,
      );
    }
  };

  return defineTool({
    name: "send_message",
    label: "SendMessage",
    description: [
      "Send a follow-up message to a NAMED live agent (spawned with spawn_subagent `name`) and get its reply.",
      "A mid-flight agent is steered — the message joins its current exchange and returns 'delivered' without a separate reply.",
      "to:'main' routes a CHILD's message up to the ROOT session (a nested child's 'main' is the root, not its intermediate parent).",
      "From inside a named child, a TEAMMATE target is parent-brokered: the message reaches the teammate AND is surfaced to the parent — no direct child→child channel (ticket 05).",
      "Protocol `type` envelopes (ticket 04): shutdown_request (parent→child two-stage stop; child→main notification), plan_approval_response (resolves a pending request_plan_approval), plan_approval_request / shutdown_response (child→main notifications).",
    ].join(" "),
    promptSnippet:
      "Follow up with a named live agent: send_message({ to: '<name|agentId>', message }) returns its reply; wait:false fires-and-forgets (reply lands as a <task-notification>); a mid-flight agent gets the message as a steer. A named child messaging a teammate goes through the parent (both see it); list_subagent_runs 'list' shows the live team roster.",
    // Owner-declared gating — the workflow family (GATE_DEFS["workflow"], workflow
    // ext): a follow-up belongs to the exact sessions that can spawn a named agent
    // (spawn_subagent carries the same reference form).
    gating: { gate: "workflow" },
    // Sequential: LiveAgent is not thread-safe across concurrent exchanges (a
    // second send while one runs degrades to steer); serializing send_message
    // calls keeps one exchange at a time per agent — same rule as spawn_subagent.
    executionMode: "sequential",
    parameters: sendMessageToolSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // Protocol envelopes (ticket 04) take the dedicated path before plain
      // routing — a shutdown_request never re-prompts as an ordinary message.
      if (params.type) return executeProtocol({ ...params, type: params.type }, signal);
      // Child→parent: the bus owns delivery (followUp + triggerTurn wake).
      // A NAMED child's identity is its stamp (ticket 05) — `from` stays as the
      // explicit override for hosts that never stamped an instance.
      if (params.to === "main") {
        const name = childIdentity(params.from);
        const published = bus.publish({ name }, params.message);
        if (!published.ok) return textResult(`send_message to main failed: ${published.error}`);
        return textResult(
          `Delivered to the parent session (from "${name}"). ` +
            "It arrives as a follow-up message; the parent answers in a later exchange — do not wait for a reply here.",
        );
      }

      const entry = liveRegistry.get(params.to);
      if (!entry) {
        return textResult(
          `No live agent "${params.to}". Live agents: ${liveRegistry.names().join(", ") || "(none)"}. ` +
            "Spawn one with spawn_subagent `name`, or check the handle with list_subagent_runs.",
        );
      }
      liveRegistry.touch(entry.name);

      // Team addressing (ticket 05) — a NAMED child addressing a TEAMMATE is
      // parent-brokered; no direct child→child channel exists. The message is
      // delivered into the target (steer when mid-flight, a fresh exchange
      // when idle) AND relayed to the parent as a followUp — both sides see
      // it, per spec §3. The sender never awaits the reply here: the target's
      // answer surfaces to the parent the same way, and the target can reply
      // to the sender by name (the same brokered path, symmetric).
      if (selfName) {
        if (entry.name === selfName) {
          return textResult(
            `"${selfName}" is YOU — a self-addressed send_message is a no-op. ` +
              "Address a teammate by name, or 'main' for the parent session.",
          );
        }
        // The relay must never describe an exchange that did not happen
        // (review finding 2): it publishes only once delivery is assured. On
        // the RUNNING branch that is after send() resolves (a throwing steer
        // or a terminal death publishes nothing); on the IDLE branch send()
        // starts the exchange synchronously, so the relay publishes up front
        // and the reply/failure relay follows when it settles.
        const publishRelay = () =>
          bus.publish({ name: selfName }, formatSiblingRelayNotification(selfName, entry.name, params.message));
        const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (entry.agent.status === "running") {
          // The target LOOKED mid-flight — steer is the expected outcome. But
          // LiveAgent.send re-checks isStreaming itself, and the target's
          // exchange can complete in the window between the two checks: a
          // non-steered result here is a FULL awaited exchange whose answer is
          // in hand (review findings 1, 3). So: await with the caller's signal
          // (the sender's turn-abort can cut the wait), catch a throwing
          // steer, and on the race surface the answer to BOTH sides instead
          // of silently dropping it.
          let result: LiveAgentSendResult;
          try {
            result = await entry.agent.send(params.message, { timeoutMs, signal });
          } catch {
            return textResult(
              `Delivery to teammate "${entry.name}" failed — the exchange threw. Nothing was relayed; re-send or check its state with list_subagent_runs.`,
            );
          }
          publishRelay();
          if (result.failure && isTerminal(result.failure)) {
            liveRegistry.release(entry.name, "terminal");
            return textResult(
              `Teammate "${entry.name}" ran out of lifetime on delivery (${result.failure.message}) — terminated and off the live roster. The parent saw the relay.`,
            );
          }
          if (result.steered) {
            return textResult(
              `Delivered to teammate "${entry.name}" — it is mid-exchange, so the message steers into that run ` +
                "(no separate reply for this send), and the parent session has been surfaced the relay.",
            );
          }
          // The race window closed: the target went idle and this ran a whole
          // exchange. Relay the answer to the parent (both-see-it) and hand
          // it to the sender directly.
          bus.publish(
            { name: entry.name, agentId: entry.agentId },
            formatSiblingReplyNotification(entry.name, selfName, result),
          );
          return textResult(
            `Delivered to teammate "${entry.name}" — its exchange had just ended, so this ran a new one. ` +
              `Reply: ${result.failure ? `${result.failure.kind}: ${result.failure.message}` : result.output || "(empty)"}`,
          );
        }
        // Idle teammate: a fresh fire-and-forget exchange. The reply is
        // relayed to the parent when it settles (capped preview) — the same
        // both-see-it rule. A terminal lifetime failure releases the agent,
        // mirroring the wait:false contract.
        const relayed = publishRelay();
        if (!relayed.ok) return textResult(`send_message to teammate "${entry.name}" failed: ${relayed.error}`);
        void entry.agent
          .send(params.message, { timeoutMs })
          .then((result) => {
            if (result.failure && isTerminal(result.failure)) liveRegistry.release(entry.name, "terminal");
            if (!result.steered) {
              bus.publish(
                { name: entry.name, agentId: entry.agentId },
                formatSiblingReplyNotification(entry.name, selfName, result),
              );
            }
          })
          .catch(() => {
            // send() classifies instead of throwing; a throw here is a broken
            // handle — nothing to relay, the roster still shows the agent.
          });
        return textResult(
          `Delivered to teammate "${entry.name}" (a new exchange) and surfaced to the parent — both see it. ` +
            `Its reply lands with the parent as a follow-up; "${entry.name}" can also reply straight to you by name.`,
        );
      }

      // Fire-and-forget (idle agent): start the exchange, return now, deliver
      // the reply as a task-notification when it settles. No parent signal —
      // a turn abort must not kill an exchange nobody is waiting on (same
      // decoupling as background dispatch, ADR-subagent-0007).
      if (params.wait === false && entry.agent.status === "idle") {
        const spec = { name: entry.name, agentId: entry.agentId, model: entry.model };
        void entry.agent
          .send(params.message, { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS })
          .then((result) => {
            // A terminal lifetime failure releases the agent here too — the
            // awaited path's contract, applied on the unwatched branch (a
            // dead agent left on the roster blocks its name and slot).
            if (result.failure && isTerminal(result.failure)) liveRegistry.release(entry.name, "terminal");
            // A steer outcome means the agent went mid-flight between the
            // status check and send() — nothing completed, no notification.
            if (!result.steered) background.deliver(formatReplyNotification(spec, result));
          })
          .catch(() => {
            // send() classifies instead of throwing; a throw here is a broken
            // handle — nothing to report, the roster still shows the agent.
          });
        return textResult(
          `Sent to "${entry.name}" (agentId ${entry.agentId}) — reply arrives as a <task-notification> follow-up. Continue with other work.`,
        );
      }

      // Awaited path — also the steer path: send() queues a steer into a
      // running exchange and returns steered:true immediately.
      const result = await entry.agent.send(params.message, {
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
      });
      if (result.steered) {
        return textResult(
          `Delivered to "${entry.name}" — it is mid-exchange, so the message steers into the current run ` +
            "(no separate reply for this send). Its answer surfaces when that exchange completes.",
        );
      }
      if (result.failure) {
        // A lifetime ceiling fired: the session is capped forever — free the
        // name/slot (records survive, keyed by agentId) and say so.
        if (isTerminal(result.failure)) {
          liveRegistry.release(entry.name, "terminal");
          return textResult(
            `Message not delivered: ${result.failure.message}. ` +
              `The agent is terminated and removed from the live roster; spawn a new one for further work.`,
          );
        }
        return textResult(
          `Exchange with "${entry.name}" did not complete (${result.failure.kind}): ${result.failure.message}. ` +
            "The session stays live — you can send again.",
        );
      }
      return textResult(result.output || `("${entry.name}" returned an empty reply.)`);
    },
  });
}
