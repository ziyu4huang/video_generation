/**
 * `schedule_wakeup` (cc-parity-2 ticket 06): the model-facing half of
 * `/loop dynamic` self-pacing. Mirrors CC's ScheduleWakeup — delaySeconds
 * clamped 60–3600 with a loud message when clamped, a required reason, and an
 * optional stop. Wakeups are in-memory and session-live (map D7).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WAKEUP_MAX_DELAY_S, WAKEUP_MIN_DELAY_S, type WakeupEntry, type WakeupRegistry } from "./wakeup-registry.js";

const schema = Type.Object({
  delaySeconds: Type.Number({
    description:
      "Seconds from now until the next wakeup (60–3600, values outside are clamped). Pick by what you're waiting on, not a round habit.",
  }),
  reason: Type.String({
    description: "One sentence: what state you're waiting on and why this delay (shown in the loop footer).",
  }),
  stop: Type.Optional(Type.Boolean({ description: "true = end the loop now (no next wakeup)." })),
});

export interface ScheduleWakeupOptions {
  registry: WakeupRegistry;
  /** The loop the tool arms: the id of the loop whose fired turn is running. */
  currentLoopId: () => string | undefined;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** Clamp with a loud message — CC behavior: values outside 60–3600 are clamped, not rejected. */
export function clampDelaySeconds(delaySeconds: number): { value: number; clamped: boolean } {
  if (!Number.isFinite(delaySeconds) || delaySeconds < 1) return { value: WAKEUP_MIN_DELAY_S, clamped: true };
  if (delaySeconds < WAKEUP_MIN_DELAY_S) return { value: WAKEUP_MIN_DELAY_S, clamped: true };
  if (delaySeconds > WAKEUP_MAX_DELAY_S) return { value: WAKEUP_MAX_DELAY_S, clamped: true };
  return { value: delaySeconds, clamped: false };
}

export function createScheduleWakeupTool(options: ScheduleWakeupOptions): ToolDefinition {
  const { registry, currentLoopId, now = () => new Date() } = options;

  const tool: ToolDefinition<typeof schema, undefined> = defineTool({
    name: "schedule_wakeup",
    label: "ScheduleWakeup",
    description:
      "Pace a /loop dynamic run: schedule this session's loop to re-fire in delaySeconds. Session-live and in-memory — the loop survives only as long as the session (no daemon, nothing durable). Pick delaySeconds by what you are actually waiting on: stay just inside the prompt-cache window when a task could finish soon (a cache miss past ~5 min costs a full uncached read); wait longer (still ≤3600s) when the thing you're watching changes on a scale of minutes; and NEVER use this to poll background work the harness already tracks (agents, workflows, CI it started) — those re-invoke you on completion. Omit it from a fired turn and the loop ends.",
    // Owner-declared gating — joins the shared workflow family gate (see
    // GATE_DEFS["workflow"] in extensions/ultracode.ts); co-fires with
    // run_workflow / the cron tools / the subagent family.
    gating: { gate: "workflow" },
    promptSnippet: "Re-arm a /loop dynamic run: schedule_wakeup({ delaySeconds, reason, stop? }).",
    parameters: schema,
    async execute(_toolCallId, params) {
      const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
      const loopId = currentLoopId();
      if (params.stop) {
        const cancelled = loopId != null && registry.cancel(loopId);
        return text(
          cancelled
            ? `Loop "${loopId}" stopped — no further wakeups.`
            : `No loop was running (nothing to stop) — a fire consumes the pending wakeup, so a loop continues only when each fired turn schedules the next one. This loop already ended naturally (nothing further to cancel).`,
        );
      }
      if (loopId == null) {
        return text(
          "No /loop is active in this session — schedule_wakeup only paces an active loop (start one with /loop dynamic <prompt>).",
        );
      }
      // After a fire the pending entry is gone — re-arm from the last-FIRED
      // snapshot (it carries the original prompt + the running fireCount).
      const existing = registry.get(loopId) ?? registry.lastFired(loopId);
      if (!existing) {
        return text(`Loop "${loopId}" is not known to this session — start one with /loop dynamic <prompt> first.`);
      }
      const { value: delaySeconds, clamped } = clampDelaySeconds(params.delaySeconds);
      const entry: WakeupEntry = {
        ...existing,
        mode: "dynamic",
        delaySeconds: undefined,
        dueAt: now().getTime() + delaySeconds * 1000,
        lastReason: params.reason,
      };
      registry.schedule(entry);
      const at = new Date(entry.dueAt).toLocaleTimeString();
      return text(
        [
          clamped
            ? `delaySeconds ${params.delaySeconds} clamped to ${delaySeconds} (allowed range ${WAKEUP_MIN_DELAY_S}–${WAKEUP_MAX_DELAY_S}).`
            : null,
          `Loop "${loopId}" re-armed: next wakeup at ${at} (in ${delaySeconds}s). Reason: ${params.reason}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    },
  });

  // ToolDefinition is invariant in its schema parameter (same cast as cron-tools).
  return tool as unknown as ToolDefinition;
}
