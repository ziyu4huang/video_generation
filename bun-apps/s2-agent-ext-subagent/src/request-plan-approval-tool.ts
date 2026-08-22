/**
 * `request_plan_approval` — the CHILD-injected plan-approval half of the
 * protocol-message layer (agent-teams parity ticket 04, effort
 * `.planning/2026-08-22-subagent-teams-parity`).
 *
 * NOT registered in the parent: the parent never asks its own parent for
 * approval, so the tool never joins pi.registerTool (and therefore no
 * tool-gate family entry — the "if parent-visible" branch of the ticket's
 * gating step is deliberately not taken). Children receive it through the
 * extensionTools bridge: the extension entry appends the definition at
 * session_start, and the named-dispatch path appends its name to the child
 * allowlist (the default allowlist is the PARENT's active set, which would
 * otherwise filter it out in applyToolPolicy).
 *
 * execute() holds a pending entry on the core-runtime PendingProtocolMap under
 * the child's self-declared name, wakes the parent through the
 * ParentMessageBus, and awaits the verdict. Timeout defaults to DENY (D6).
 * In-process only: a detached resume subprocess refuses with a clear error.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getPendingProtocolMap, type PendingProtocolMap } from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";
import { getParentMessageBus, type ParentMessageBus } from "./parent-message-bus.js";
import {
  DEFAULT_PLAN_APPROVAL_TIMEOUT_MS,
  formatPlanApprovalRequestNotification,
  isDetachedResumeHost,
} from "./protocol-format.js";

export const REQUEST_PLAN_APPROVAL_TOOL_NAME = "request_plan_approval";

export const requestPlanApprovalToolSchema = Type.Object({
  plan: Type.String({
    description:
      "The plan you want approved BEFORE proceeding — concrete, ordered steps. The parent sees exactly this text.",
  }),
  from: Type.Optional(
    Type.String({
      description:
        'Your live-agent name (the `name` you were spawned with), so the parent can address the response back. Defaults to "child".',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `How long to wait for the parent's verdict in ms (default ${DEFAULT_PLAN_APPROVAL_TIMEOUT_MS}). No verdict in time = DENIED.`,
    }),
  ),
});

export interface RequestPlanApprovalToolOptions {
  /** Child→parent bus (the wake seam). Defaults to the process singleton. */
  bus?: ParentMessageBus;
  /** Pending-protocol map the verdict resolves through. Defaults to the core-runtime singleton. */
  pending?: PendingProtocolMap;
  /** Injectable for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export function createRequestPlanApprovalTool(
  options: RequestPlanApprovalToolOptions = {},
): ToolDefinition<typeof requestPlanApprovalToolSchema, undefined> {
  const bus = options.bus ?? getParentMessageBus();
  const pending = options.pending ?? getPendingProtocolMap();
  const env = options.env;
  return defineTool({
    name: REQUEST_PLAN_APPROVAL_TOOL_NAME,
    label: "RequestPlanApproval",
    description: [
      "Ask the parent session to APPROVE a plan before you proceed (named live agents only).",
      "Blocks until the parent responds (send_message plan_approval_response) or the timeout denies.",
      "Use before work that is expensive or hard to reverse.",
    ].join(" "),
    promptSnippet:
      "Before expensive or hard-to-reverse work, a named live agent can ask: request_plan_approval({ plan, from: '<your name>' }) — the parent's approve/deny arrives as the tool result (timeout denies).",
    // Deliberately NOT gated and NOT parent-registered (see module header).
    // executionMode: sequential — one pending hold per agent at a time; the
    // map itself enforces this (a second hold releases the first).
    parameters: requestPlanApprovalToolSchema,
    async execute(_toolCallId, params, signal) {
      if (isDetachedResumeHost(env)) {
        return textResult(
          "request_plan_approval is unavailable in a detached resume subprocess — the parent session lives in another process and cannot respond. " +
            "Proceed with your best judgment, write the outcome to disk, and finish.",
        );
      }
      const name = params.from?.trim() || "child";
      const timeoutMs = params.timeoutMs ?? DEFAULT_PLAN_APPROVAL_TIMEOUT_MS;

      // Publish BEFORE holding: a failed wake must not leave a pending entry
      // (the timeout would deny a request the parent never saw).
      const published = bus.publish({ name }, formatPlanApprovalRequestNotification({ name }, params.plan));
      if (!published.ok) {
        return textResult(
          `Plan approval unavailable: ${published.error} Proceed without approval, or surface the decision point in your reply.`,
        );
      }

      // A turn abort while waiting drops the hold (default-deny) so the map
      // never leaks an entry whose child stopped listening. Registered BEFORE
      // the await — after it resolves there is nothing left to race.
      const onAbort = () => pending.release(name);
      signal?.addEventListener("abort", onAbort, { once: true });
      let verdict: Awaited<ReturnType<PendingProtocolMap["hold"]>>;
      try {
        verdict = await pending.hold(name, params.plan, timeoutMs);
        if (verdict.released) {
          return textResult(
            "Plan approval wait was dropped (session or exchange ended) — DENIED by default. Proceed only if safe.",
          );
        }
        if (verdict.timedOut) {
          return textResult(
            `Plan approval TIMED OUT after ${Math.round(timeoutMs / 1000)}s with no parental verdict — DENIED by default (budget-safe default, D6). ` +
              "Only proceed if the work is cheap and reversible; otherwise report the decision point in your reply.",
          );
        }
        return verdict.approved
          ? textResult(
              `Plan APPROVED by the parent.${verdict.feedback ? ` Feedback: ${verdict.feedback}` : ""} Proceed.`,
            )
          : textResult(
              `Plan DENIED by the parent.${verdict.feedback ? ` Feedback: ${verdict.feedback}` : ""} Do not proceed with this plan; adjust or report back.`,
            );
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
