/**
 * `workflow_control` tool — agent-callable stop/pause/resume (and, in later
 * tasks, status/list/wait) over a background `workflow` run.
 *
 * Thin wrapper: WorkflowManager.stop()/pause()/resume() already do the real
 * work (including correctly calling a real AbortController.abort()
 * internally) — this tool adds zero new business logic, just a tool surface
 * over them, mirroring the /workflows slash-command version of the same
 * operations in workflow-commands.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recomputeWorkflowSnapshot, renderWorkflowText } from "./display.js";
import { renderPersistedStatus, summarizeRun } from "./workflow-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";

const workflowControlActionEnum = StringEnum(["stop", "pause", "resume", "status", "list", "wait"] as const);

const workflowControlToolSchema = Type.Object({
  action: workflowControlActionEnum,
  runId: Type.Optional(
    Type.String({
      description:
        "The run ID returned by the workflow tool's background start. Required for stop/pause/resume/status/wait; ignored by list.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "wait only: how long to block for the run to finish, in milliseconds. Default 30000, clamped to [1000, 300000].",
    }),
  ),
});

export type WorkflowControlToolInput = {
  action: "stop" | "pause" | "resume" | "status" | "list" | "wait";
  runId?: string;
  timeoutMs?: number;
};

export interface WorkflowControlToolOptions {
  manager: WorkflowManager;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function requireRunId(action: string, runId: string | undefined): string {
  if (!runId) throw new Error(`workflow_control: action "${action}" requires runId`);
  return runId;
}

/** Run IDs the manager currently reports as "running" — used to help the
 *  model self-correct a stale/wrong runId without a separate list call. */
function runningIds(manager: WorkflowManager): string[] {
  return manager
    .listRuns()
    .filter((r) => r.status === "running")
    .map((r) => r.runId);
}

const NO_POLL_HINT = "Prefer waiting for the automatic completion notification over polling repeatedly.";

const WAIT_DEFAULT_MS = 30_000;
const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 300_000;
const WAIT_FINAL_EVENTS = ["complete", "error", "stopped", "paused"] as const;

function clampWaitTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.floor(value)));
}

/** Block until `runId` reaches a terminal/paused state or `timeoutMs` elapses,
 *  then return its current status text. A run that is not actively "running"
 *  in this process (already finished, or unknown) resolves immediately —
 *  there is nothing to wait for. A timeout is not an error: it returns the
 *  still-running snapshot so the model can decide to wait again or yield. */
function waitForRun(
  manager: WorkflowManager,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const managed = manager.getRun(runId);
  if (!managed || (managed as { status?: string }).status !== "running") {
    return Promise.resolve(renderRunStatus(manager, runId));
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (e?: { runId?: string }) => {
      if (settled || (e && e.runId !== runId)) return;
      settled = true;
      clearTimeout(timer);
      for (const ev of WAIT_FINAL_EVENTS) manager.off(ev, finish);
      signal?.removeEventListener("abort", onAbort);
      resolve(renderRunStatus(manager, runId));
    };
    const onAbort = () => finish();
    for (const ev of WAIT_FINAL_EVENTS) manager.on(ev, finish);
    timer = setTimeout(() => finish(), timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Live snapshot if the run is active in this process, else the persisted
 *  status if it exists at all, else undefined. Mirrors the fallback chain
 *  the /workflows status|watch slash command already uses. */
function renderRunStatus(manager: WorkflowManager, runId: string): string | undefined {
  const live = manager.getSnapshot(runId);
  if (live) return renderWorkflowText(recomputeWorkflowSnapshot(live), false);
  const run = manager.listRuns().find((r) => r.runId === runId);
  return run ? renderPersistedStatus(run) : undefined;
}

function renderRunList(manager: WorkflowManager): string {
  const runs = manager.listRuns();
  if (!runs.length) return "No workflow runs yet.";
  return [...runs.map(summarizeRun), "", NO_POLL_HINT].join("\n");
}

export function createWorkflowControlTool(
  options: WorkflowControlToolOptions,
): ToolDefinition<typeof workflowControlToolSchema, undefined> {
  const { manager } = options;
  return defineTool({
    name: "workflow_control",
    label: "WorkflowControl",
    description:
      "Stop, pause, resume, inspect, or wait on a background workflow run (a run started by the workflow tool with background: true). Use runId from the workflow tool's background-start result.",
    // Owner-declared gating — mirrored IDENTICALLY from `workflow` (same combined
    // gate signature). See `workflow`'s gating comment: tickets 10 + 11 are one
    // atomic rollout over the single combined workflow/subagent gate, so all 4
    // tools share the SAME keywords-only gating and collapse back into one
    // 4-name gate (names[0] === "workflow") — when the gate fires, all 4 names
    // activate together (co-fire preserved). See `workflow`'s gating comment.
    gating: {
      keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"],
    },
    promptSnippet:
      "Control a background workflow run: workflow_control({ action, runId }). action is one of stop | pause | resume | status | list | wait.",
    parameters: workflowControlToolSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "stop": {
          const runId = requireRunId("stop", params.runId);
          if (manager.stop(runId)) return textResult(`Stopped ${runId}.`);
          const ids = runningIds(manager);
          return textResult(
            ids.length
              ? `Cannot stop ${runId} (not running). Currently running: ${ids.join(", ")}.`
              : `Cannot stop ${runId} (not running). No runs are currently running.`,
          );
        }
        case "pause": {
          const runId = requireRunId("pause", params.runId);
          const ok = manager.pause(runId);
          return textResult(ok ? `Paused ${runId}.` : `Cannot pause ${runId} (not running).`);
        }
        case "resume": {
          const runId = requireRunId("resume", params.runId);
          const ok = await manager.resume(runId);
          return textResult(ok ? `Resumed ${runId}.` : `Resume not available for ${runId} yet.`);
        }
        case "status": {
          const runId = requireRunId("status", params.runId);
          const text = renderRunStatus(manager, runId);
          return textResult(text ? `${text}\n\n${NO_POLL_HINT}` : `No workflow run "${runId}".`);
        }
        case "list":
          return textResult(renderRunList(manager));
        case "wait": {
          const runId = requireRunId("wait", params.runId);
          const text = await waitForRun(manager, runId, clampWaitTimeoutMs(params.timeoutMs), signal);
          return textResult(text ?? `No workflow run "${runId}".`);
        }
        default:
          throw new Error(`workflow_control: action "${params.action}" not yet implemented`);
      }
    },
  });
}
