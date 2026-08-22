/**
 * Protocol-message shared constants + notification formats (agent-teams parity
 * ticket 04, effort `.planning/2026-08-22-subagent-teams-parity`).
 *
 * Presentation only — every RULE lives at its owner (PendingProtocolMap in
 * core-runtime holds/resolves plan approvals; the live-agent registry owns
 * disposal). The shutdown wrap-up notice deliberately mirrors
 * BUDGET_WRAP_UP_MESSAGE (core-runtime agent-budget.ts): same shape — final
 * turn, flush state to disk, reply with a pointer — so a child sees one
 * consistent "last words" contract whether the budget guard or a parental
 * shutdown_request fired it.
 */

/**
 * Stage-1 notice for a parent→child shutdown_request: steer text the child's
 * model sees on its final turn, before the grace timer stops the session.
 */
export const SHUTDOWN_WRAP_UP_MESSAGE =
  "Shutdown requested by the parent — this is your FINAL turn. Do not start new work or long tool calls. Write your current findings/state/artifacts to disk now (files, not prose), then reply with a one-line pointer to what you saved.";

/** Default grace window before stage 2 (abort) fires on a shutdown_request. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 60_000;

/** Default plan-approval wait before the D6 default-deny fires. */
export const DEFAULT_PLAN_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Env marker set on the detached resume subprocess (detach-run.ts
 * spawnDetachedChild). The protocol layer is IN-PROCESS ONLY: a detached
 * child's parent lives in another OS process, so no bus, pending map, or
 * registry it can reach is the real one — every protocol surface refuses with
 * a clear error instead of silently talking to itself.
 */
export const SUBAGENT_DETACHED_RESUME_ENV = "SUBAGENT_DETACHED_RESUME";

/** Whether THIS process is a detached resume subprocess (protocol layer refuses). */
export function isDetachedResumeHost(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[SUBAGENT_DETACHED_RESUME_ENV]);
}

/** Child→parent plan-approval request notification (the followUp the parent wakes to). */
export function formatPlanApprovalRequestNotification(from: { name: string; agentId?: string }, plan: string): string {
  return [
    "<plan-approval-request>",
    `Live agent "${from.name}"${from.agentId ? ` (agentId ${from.agentId})` : ""} requests approval before proceeding:`,
    plan,
    "",
    `Respond with send_message { to: "${from.name}", type: "plan_approval_response", approve: true|false [, feedback: "…"] } — no response within the agent's timeout DENIES by default.`,
    "</plan-approval-request>",
  ].join("\n");
}

/** Child→parent shutdown_request notification — informational; the parent approves by stopping. */
export function formatShutdownRequestNotification(from: { name: string; agentId?: string }, message: string): string {
  return [
    "<shutdown-request>",
    `Live agent "${from.name}"${from.agentId ? ` (agentId ${from.agentId})` : ""} reports it is done and requests shutdown:`,
    message,
    "",
    "This is a notification, not a question — approve by stopping the agent: list_subagent_runs { action: 'stop', id: '<name>' }. It keeps running (and spending) until you do.",
    "</shutdown-request>",
  ].join("\n");
}
