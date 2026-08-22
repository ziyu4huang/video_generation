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
import type { LiveAgentRegistry, LiveAgentSendResult } from "@repo/s2-agent-core-runtime";
import { getLiveAgentRegistry } from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";
import type { BackgroundRunOutcome, BackgroundRunSpec } from "./background-run-manager.js";
import { getBackgroundRunManager } from "./background-run-manager.js";
import type { ParentMessageBus } from "./parent-message-bus.js";
import { getParentMessageBus } from "./parent-message-bus.js";
import { DEFAULT_TIMEOUT_MS } from "./subagent-tool-schema.js";

export const sendMessageToolSchema = Type.Object({
  to: Type.String({
    description:
      "Target: a live agent's `name` or `agentId` (from spawn_subagent `name`), or 'main' to address the parent session (a CHILD reporting up).",
  }),
  message: Type.String({ description: "The message text. Self-contained — a follow-up exchange, not a new task." }),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Block until the agent replies (default true). false returns immediately; the reply arrives as a <task-notification> follow-up.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Per-exchange wall-clock cap in ms for the awaited reply (default 15 min)." }),
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
  /** Completion notifier for wait:false exchanges (the BackgroundRunManager deliverer). Defaults to the singleton. */
  background?: { notify(spec: BackgroundRunSpec, outcome: BackgroundRunOutcome): void };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Terminal lifetime failure — the agent can never exchange again, so it leaves the roster (records survive, keyed by agentId). */
function isTerminal(failure: NonNullable<LiveAgentSendResult["failure"]>): boolean {
  return failure.kind === "budget" || failure.kind === "turns";
}

/** Map an exchange outcome onto the task-notification status vocabulary. */
function notificationOutcome(result: LiveAgentSendResult): BackgroundRunOutcome {
  return result.failure
    ? { status: result.failure.kind as BackgroundRunOutcome["status"], output: result.output || result.failure.message }
    : { status: "done", output: result.output };
}

export function createSendMessageTool(
  options: SendMessageToolOptions = {},
): ToolDefinition<typeof sendMessageToolSchema, undefined> {
  const liveRegistry = options.liveRegistry ?? getLiveAgentRegistry();
  const bus = options.bus ?? getParentMessageBus();
  const background = options.background ?? getBackgroundRunManager();
  return defineTool({
    name: "send_message",
    label: "SendMessage",
    description: [
      "Send a follow-up message to a NAMED live agent (spawned with spawn_subagent `name`) and get its reply.",
      "A mid-flight agent is steered — the message joins its current exchange and returns 'delivered' without a separate reply.",
      "to:'main' routes a CHILD's message up to the parent session.",
    ].join(" "),
    promptSnippet:
      "Follow up with a named live agent: send_message({ to: '<name|agentId>', message }) returns its reply; wait:false fires-and-forgets (reply lands as a <task-notification>); a mid-flight agent gets the message as a steer.",
    // Sequential: LiveAgent is not thread-safe across concurrent exchanges (a
    // second send while one runs degrades to steer); serializing send_message
    // calls keeps one exchange at a time per agent — same rule as spawn_subagent.
    executionMode: "sequential",
    parameters: sendMessageToolSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // Child→parent: the bus owns delivery (followUp + triggerTurn wake).
      if (params.to === "main") {
        const published = bus.publish({ name: params.from ?? "child" }, params.message);
        if (!published.ok) return textResult(`send_message to main failed: ${published.error}`);
        return textResult(
          `Delivered to the parent session${params.from ? ` (from "${params.from}")` : ""}. ` +
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

      // Fire-and-forget (idle agent): start the exchange, return now, deliver
      // the reply as a task-notification when it settles. No parent signal —
      // a turn abort must not kill an exchange nobody is waiting on (same
      // decoupling as background dispatch, ADR-subagent-0007).
      if (params.wait === false && entry.agent.status === "idle") {
        const spec: BackgroundRunSpec = {
          id: entry.agentId,
          agent: entry.name,
          model: entry.model ?? "default",
          taskPreview: `send_message follow-up → ${entry.name}`,
          startedAt: Date.now(),
        };
        void entry.agent
          .send(params.message, { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS })
          .then((result) => {
            // A steer outcome means the agent went mid-flight between the
            // status check and send() — nothing completed, no notification.
            if (!result.steered) background.notify(spec, notificationOutcome(result));
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
