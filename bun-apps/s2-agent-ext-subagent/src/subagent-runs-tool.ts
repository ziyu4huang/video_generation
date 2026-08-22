/**
 * `subagent_runs` tool — model-callable read-back of durable `subagent`-tool
 * run records (`~/.pi/subagents/runs/<id>.json`, last-N=200). The records are
 * written by the `subagent` dispatch tool on every completed run; this tool is
 * their FIRST reader, letting the parent agent recall cross-session runs (the
 * human `/subagents` viewer reads only the current session branch).
 *
 * Mirrors the `workflow_control` precedent: a second, action-based tool. Pure
 * read, no side effects → parallel-safe (does NOT declare executionMode
 * "sequential", unlike the dispatch tool). Backed by SubagentRunPersistence.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isTerminalStatus,
  type SubagentInFlightRegistry,
  type SubagentRunPersistence,
  type SubagentRunRecord,
} from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";
import type { BackgroundRunManager } from "./background-run-manager.js";

const subagentRunsActionEnum = StringEnum(["list", "get", "wait", "stop"] as const, {
  description:
    "Discriminator: 'list' recent runs, 'get' one by id, 'wait' block on a live run, 'stop' abort a live run or stop a named live agent (by name or agentId).",
});

const statusFilterEnum = StringEnum(["done", "failed", "timedout", "budget"] as const, {
  description: "list: filter to a run status (done|failed|timedout|budget).",
});

const subagentRunsSchema = Type.Object({
  action: subagentRunsActionEnum,
  limit: Type.Optional(Type.Number({ description: "list: max runs to return (default 10)." })),
  status: Type.Optional(statusFilterEnum),
  cwd: Type.Optional(Type.String({ description: "list: scope to runs with this working directory." })),
  id: Type.Optional(
    Type.String({
      description:
        "get/wait/stop: run id (required for those actions). stop also accepts a NAMED live agent's name or agentId.",
    }),
  ),
  includeHistory: Type.Optional(
    Type.Boolean({ description: "get: include the compact tool transcript (default false — can be large)." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "wait: max ms to block (default 30000, cap 300000). Timeout returns current status, never an error.",
    }),
  ),
});

export interface SubagentRunsToolOptions {
  persistence: SubagentRunPersistence;
  /** Live-run source for wait/stop. Omitted = wait/stop report unavailable. */
  inFlight?: SubagentInFlightRegistry;
  /** Background roster (forward-use: wait/stop telemetry). Omitted is fine. */
  background?: BackgroundRunManager;
  /**
   * Live-agent registry for stop-by-NAME (ticket 04): a named live agent is
   * stoppable by `name`/`agentId` — the shutdown lever a child's
   * shutdown_request notification points at. Structural (get/release) so tests
   * can pass a minimal fake.
   */
  liveRegistry?: {
    get(nameOrAgentId: string): { name: string; agentId: string } | undefined;
    release(name: string, reason?: string): boolean;
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function taskPreview(task: string, n = 60): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function fmtTokens(usage: SubagentRunRecord["usage"]): string {
  return usage?.total ? String(usage.total) : "—";
}

/** Compact total-token label for the stats header: `392k` / `1.7M` / `0`. */
function compactTokenTotal(records: SubagentRunRecord[]): string {
  const total = records.reduce((sum, r) => sum + (r.usage?.total ?? 0), 0);
  if (!total) return "0";
  return total >= 1e6 ? `${(total / 1e6).toFixed(1)}M` : `${Math.round(total / 1e3)}k`;
}

/** `MM-DD HH:MM` from a persisted ISO timestamp (slice, no Date round-trip). */
function spanStamp(iso: string): string {
  return iso.slice(5, 16).replace("T", " ");
}

/**
 * Render the `list` output: a two-line header (what this archive is, then
 * aggregate stats) followed by the per-row lines. `filtered` is the post
 * status/cwd-filter set (before the limit slice) — the counts denominator;
 * `shown` is the sliced rows the token total and span are computed over.
 */
function renderRunsList(
  shown: SubagentRunRecord[],
  filtered: SubagentRunRecord[],
  filters: { status?: string; cwd?: string } = {},
): string {
  // Status segment: the five named statuses in fixed order, then any other
  // status present in the set (e.g. "aborted") appended so unknown values
  // never crash the render.
  const counts = new Map<string, number>();
  for (const r of filtered) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const statusSeg = ["done", "failed", "timedout", "turns", "budget"].map((s) => `${s} ${counts.get(s) ?? 0}`);
  for (const s of ["done", "failed", "timedout", "turns", "budget"]) counts.delete(s);
  for (const [s, n] of counts) statusSeg.push(`${s} ${n}`);

  // Span: oldest→newest startedAt among the shown rows. Single value only
  // for exactly one row; none at all → em-dash. Equal timestamps across ≥2
  // rows still render the arrow form (spec: collapse only on row count).
  let span = "—";
  let oldest: SubagentRunRecord | undefined;
  let newest: SubagentRunRecord | undefined;
  for (const r of shown) {
    const t = new Date(r.startedAt).getTime();
    if (!oldest || t < new Date(oldest.startedAt).getTime()) oldest = r;
    if (!newest || t > new Date(newest.startedAt).getTime()) newest = r;
  }
  const [first] = shown;
  if (shown.length === 1 && first) {
    span = spanStamp(first.startedAt);
  } else if (oldest && newest) {
    span = `${spanStamp(oldest.startedAt)}→${spanStamp(newest.startedAt)}`;
  }

  // Stats line — active filters annotate the very end, after the span.
  const statsLine = [
    `Showing ${shown.length} most recent of ${filtered.length} total`,
    ...statusSeg,
    `${compactTokenTotal(shown)} tok total`,
    `span ${span}`,
  ].join(" · ");
  const trailer = [
    filters.status ? `filter: status=${filters.status}` : "",
    filters.cwd ? `filter: cwd=${filters.cwd}` : "",
  ].filter(Boolean);

  const lines = [
    "Subagent run history — read-only archive of past subagent/subagents dispatches (~/.pi/subagents/runs)",
    trailer.length ? `${statsLine} · ${trailer.join(" · ")}` : statsLine,
  ];
  if (!shown.length) {
    lines.push("No runs match.");
    return lines.join("\n");
  }
  lines.push(
    ...shown.map(
      (r, i) =>
        `#${i + 1}  [${r.status}]  ${r.model}  ·  ${taskPreview(r.task)}  ·  ${r.startedAt}  ·  ${Math.round(r.elapsedMs)}ms  ·  ${fmtTokens(r.usage)} tok  ·  id=${r.id}`,
    ),
  );
  return lines.join("\n");
}

function renderRun(record: SubagentRunRecord, includeHistory: boolean): string {
  const lines = [
    `# subagent run ${record.id}`,
    `status: ${record.status}  ·  model: ${record.model}  ·  started: ${record.startedAt}  ·  ${Math.round(record.elapsedMs)}ms  ·  ${fmtTokens(record.usage)} tok`,
    `task: ${record.task}`,
  ];
  if (record.report) lines.push(`sdd: ${record.report.status ?? "?"}`);
  if (record.scopeCheck?.outOfScope?.length) lines.push(`scope violations: ${record.scopeCheck.outOfScope.join(", ")}`);
  if (record.budget) lines.push(`budget: ${record.budget.kind} ${record.budget.actual}/${record.budget.limit}`);
  lines.push("", "## output", record.output || "(empty)");
  // H2: salvage block for aborted runs — rendered unless the output already
  // carries the appended section (singular-tool records persist it inline;
  // batch-tool records are record-only, so this is where it surfaces).
  if (record.salvage && !record.output.includes("--- salvage (terminal abort) ---")) {
    lines.push("", "## salvage (terminal abort)");
    if (record.salvage.files?.length) lines.push(`files touched: ${record.salvage.files.join(", ")}`);
    if (record.salvage.lastText) lines.push("last words:", record.salvage.lastText);
  }
  if (includeHistory && record.history?.length) {
    lines.push("", "## transcript");
    for (const h of record.history) {
      const label = h.toolName ? `${h.kind}:${h.toolName}` : h.kind;
      lines.push(`- [${label}] ${h.text.slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

export function createSubagentRunsTool(
  options: SubagentRunsToolOptions,
): ToolDefinition<typeof subagentRunsSchema, undefined> {
  const { persistence } = options;
  return defineTool({
    // Renamed 2026-08-20 (tool-name verb_object effort): legacy name
    // `subagent_runs` — see docs/agents/extension-naming.md for the rename history.
    name: "list_subagent_runs",
    label: "SubagentRuns",
    description:
      "Read back subagent-tool runs (cross-session archive at ~/.pi/subagents/runs + this session's live registry). action 'list' returns recent runs (newest-first; optional status/cwd filter, limit); action 'get' returns one run's full output + metadata by id (includeHistory for the compact transcript); action 'wait' blocks on a LIVE run until terminal or timeoutMs (timeout returns current status, never an error); action 'stop' aborts a live run.",
    promptSnippet:
      "Recall past subagent runs: list_subagent_runs({ action: 'list' [, status, cwd, limit] }) for recent runs, list_subagent_runs({ action: 'get', id }) for one run's output; for a live/background run, list_subagent_runs({ action: 'wait', id [, timeoutMs] }) blocks until it finishes and list_subagent_runs({ action: 'stop', id }) aborts it.",
    parameters: subagentRunsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list": {
          let records = persistence.list();
          if (params.status) records = records.filter((r) => r.status === params.status);
          if (params.cwd) records = records.filter((r) => r.cwd === params.cwd);
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? Math.max(0, Math.floor(params.limit))
              : 10;
          return textResult(
            renderRunsList(records.slice(0, limit), records, { status: params.status, cwd: params.cwd }),
          );
        }
        case "get": {
          if (!params.id) throw new Error("list_subagent_runs: action 'get' requires id");
          const record = persistence.load(params.id);
          if (!record) return textResult(`No subagent run with id "${params.id}".`);
          return textResult(renderRun(record, params.includeHistory === true));
        }
        case "wait": {
          if (!params.id) throw new Error("list_subagent_runs: action 'wait' requires id");
          if (!options.inFlight) return textResult("wait unavailable: no live-run registry in this host.");
          const cap = 300_000;
          const requested = params.timeoutMs ?? 30_000;
          const timeoutMs = Math.min(Math.max(0, requested), cap);
          const deadline = Date.now() + timeoutMs;
          // Eviction-race memory (dispatchChild's finally evicts the registry
          // entry BEFORE the persisted record lands — watchdog review can sit
          // between): if an earlier poll saw this entry live, a vanished entry
          // is "record not written yet", never "run never existed".
          let sawLive = false;
          for (;;) {
            const v = options.inFlight.view(params.id);
            if (v) sawLive = true;
            if (!v || isTerminalStatus(v.status)) {
              const record = persistence.load(params.id);
              if (record) return textResult(renderRun(record, false));
              return textResult(
                v || sawLive
                  ? `run ${params.id}: ${v ? v.status : "completing"} (no persisted record yet — it should appear shortly; try 'get').`
                  : `No subagent run with id "${params.id}".`,
              );
            }
            if (signal?.aborted) return textResult(`wait aborted; run ${params.id} still ${v.status}.`);
            if (Date.now() >= deadline) {
              return textResult(
                `run ${params.id}: still running after ${Math.round(timeoutMs / 1000)}s (elapsed ${Math.round(v.elapsedMs / 1000)}s, latest: ${v.latestAction ?? v.taskPreview}). Wait again, follow live in /subagents, or stop it.`,
              );
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        case "stop": {
          if (!params.id) throw new Error("list_subagent_runs: action 'stop' requires id");
          if (!options.inFlight) return textResult("stop unavailable: no live-run registry in this host.");
          const v = options.inFlight.view(params.id);
          // Stop-by-name (ticket 04): a NAMED live agent resolves by name or
          // agentId — either to its live FIRST-exchange run (id = agentId), or,
          // between exchanges, to the registry itself (a named agent parked on
          // the roster has no in-flight entry at all).
          if (!v && options.liveRegistry) {
            const entry = options.liveRegistry.get(params.id);
            if (entry) {
              const firstExchange = options.inFlight.view(entry.agentId);
              if (firstExchange && !isTerminalStatus(firstExchange.status)) {
                options.inFlight.abort(entry.agentId);
                return textResult(
                  `stop requested for live agent "${entry.name}" (first-exchange run ${entry.agentId}) — it ends with status "aborted".`,
                );
              }
              options.liveRegistry.release(entry.name, "user-stop");
              return textResult(
                `stopped live agent "${entry.name}" — session disposed and removed from the live roster. Run records survive, keyed by agentId ${entry.agentId}.`,
              );
            }
          }
          if (!v)
            return textResult(
              `unknown run "${params.id}" — not live in this session (registry) and not a live agent name. Completed runs: action 'list'.`,
            );
          if (isTerminalStatus(v.status))
            return textResult(`run ${params.id} already finished (${v.status}); nothing to stop.`);
          options.inFlight.abort(params.id);
          return textResult(
            `stop requested for run ${params.id} — it ends with status "aborted"; a <task-notification> follow-up (background runs only) or the run record confirms it.`,
          );
        }
        default:
          throw new Error(`list_subagent_runs: action "${params.action}" not implemented`);
      }
    },
  });
}
