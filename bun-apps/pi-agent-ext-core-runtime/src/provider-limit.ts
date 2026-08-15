/**
 * Provider usage/quota/rate-limit detection from assistant-message METADATA.
 *
 * Split out of agent.ts so structured-output.ts can call throwIfProviderLimit
 * without a cycle — agent.ts imports structured-output.js.
 *
 * Distinct from errors.ts's classifyProviderLimit, which matches free-form text
 * on a THROWN error. This is the message-metadata path. It lives here rather
 * than in errors.ts to keep that module a dependency-free leaf: this one needs
 * the pi-ai AssistantMessage type.
 *
 * lastAssistantError is exported only for testability and barrel back-compat;
 * throwIfProviderLimit is its sole production caller.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}
