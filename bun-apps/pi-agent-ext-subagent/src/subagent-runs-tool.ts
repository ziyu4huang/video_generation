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
import type { SubagentRunPersistence, SubagentRunRecord } from "@repo/pi-agent-core-runtime";
import { Type } from "typebox";

const subagentRunsActionEnum = StringEnum(["list", "get"] as const, {
  description: "Discriminator: 'list' recent runs or 'get' one run by id.",
});

const statusFilterEnum = StringEnum(["done", "failed", "timedout", "budget"] as const, {
  description: "list: filter to a run status (done|failed|timedout|budget).",
});

const subagentRunsSchema = Type.Object({
  action: subagentRunsActionEnum,
  limit: Type.Optional(Type.Number({ description: "list: max runs to return (default 10)." })),
  status: Type.Optional(statusFilterEnum),
  cwd: Type.Optional(Type.String({ description: "list: scope to runs with this working directory." })),
  id: Type.Optional(Type.String({ description: "get: run id (required for action 'get')." })),
  includeHistory: Type.Optional(
    Type.Boolean({ description: "get: include the compact tool transcript (default false — can be large)." }),
  ),
});

export interface SubagentRunsToolOptions {
  persistence: SubagentRunPersistence;
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
      "Read back historical subagent-tool runs (cross-session, from ~/.pi/subagents/runs). action 'list' returns recent runs (newest-first; optional status/cwd filter, limit); action 'get' returns one run's full output + metadata by id (includeHistory for the compact transcript). Read-only — completed records, not live runs.",
    promptSnippet:
      "Recall past subagent runs: list_subagent_runs({ action: 'list' [, status, cwd, limit] }) for recent runs, list_subagent_runs({ action: 'get', id }) for one run's output.",
    parameters: subagentRunsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
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
        default:
          throw new Error(`list_subagent_runs: action "${params.action}" not implemented`);
      }
    },
  });
}
