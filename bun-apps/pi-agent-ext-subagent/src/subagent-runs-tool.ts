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
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRunPersistence, SubagentRunRecord } from "./subagent-run-persistence.js";

const subagentRunsActionEnum = Type.Union([Type.Literal("list"), Type.Literal("get")], {
  description: "Discriminator: 'list' recent runs or 'get' one run by id.",
});

const statusFilterEnum = Type.Union(
  [Type.Literal("done"), Type.Literal("failed"), Type.Literal("timedout"), Type.Literal("budget")],
  { description: "list: filter to a run status (done|failed|timedout|budget)." },
);

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

function renderRunsList(records: SubagentRunRecord[]): string {
  if (!records.length) return "No subagent runs recorded.";
  const lines = records.map(
    (r, i) =>
      `#${i + 1}  [${r.status}]  ${r.model}  ·  ${taskPreview(r.task)}  ·  ${r.startedAt}  ·  ${Math.round(r.elapsedMs)}ms  ·  ${fmtTokens(r.usage)} tok  ·  id=${r.id}`,
  );
  return [`Recent subagent runs (${records.length}):`, ...lines].join("\n");
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
    name: "subagent_runs",
    label: "SubagentRuns",
    description:
      "Read back historical subagent-tool runs (cross-session, from ~/.pi/subagents/runs). action 'list' returns recent runs (newest-first; optional status/cwd filter, limit); action 'get' returns one run's full output + metadata by id (includeHistory for the compact transcript). Read-only — completed records, not live runs.",
    promptSnippet:
      "Recall past subagent runs: subagent_runs({ action: 'list' [, status, cwd, limit] }) for recent runs, subagent_runs({ action: 'get', id }) for one run's output.",
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
          return textResult(renderRunsList(records.slice(0, limit)));
        }
        case "get": {
          if (!params.id) throw new Error("subagent_runs: action 'get' requires id");
          const record = persistence.load(params.id);
          if (!record) return textResult(`No subagent run with id "${params.id}".`);
          return textResult(renderRun(record, params.includeHistory === true));
        }
        default:
          throw new Error(`subagent_runs: action "${params.action}" not implemented`);
      }
    },
  });
}
