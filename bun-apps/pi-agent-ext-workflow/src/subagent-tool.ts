/**
 * `subagent` tool — agent-callable single-agent dispatch over `spawnSubagent()`.
 *
 * Closes the Layer-3 drift: superpowers' subagent-driven-development and
 * dispatching-parallel-agents speak in terms of "dispatch a subagent" via the
 * `Subagent (general-purpose):` template; on Pi that resolves to "use an
 * installed `subagent` tool if available". This tool IS that surface, backed by
 * the workflow extension's existing isolated-child runner (WorkflowAgent.run).
 *
 * Minimal v1: { agent?, task, model?, cwd?, tools?, excludeTools? } → child output.
 * No clarify-TUI / acceptance / turnBudget / toolBudget (deferred — see spec.md).
 */
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  listAgentTypes,
  loadAgentRegistry,
  resolveAgentType,
  type AgentDefinition,
  type AgentRegistry,
} from "./agent-registry.js";
import {
  spawnSubagent,
  type SpawnSubagentOptions,
  type SpawnSubagentResult,
} from "./spawn-subagent.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** params.model, or "default". */
  model?: string;
  /** First ~80 chars of params.task, single-lined. */
  taskPreview: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  status: "done" | "failed" | "timedout";
  /** Real token/cost usage from the child session, when reported. */
  usage?: AgentUsage;
}

export const subagentToolSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Informational role/label for the subagent (e.g. 'implementer', 'reviewer', 'researcher'). Forwarded as an instructions prefix; does not change tool selection.",
    }),
  ),
  agentType: Type.Optional(
    Type.String({
      description:
        "Named agent definition (.pi/agents/<name>.md or ~/.pi/agents/<name>.md) binding tools/model/prompt/worktree-isolation for this call. Explicit `model`/`tools`/`excludeTools` on this call override the binding's values.",
    }),
  ),
  task: Type.String({
    description:
      "The full, self-contained prompt for the subagent. The child has NO access to this session's history — include everything it needs (goal, context, constraints, and the report format to return).",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Model override for the child as provider/id (e.g. 'anthropic/claude-sonnet-4', 'google/gemini-3-pro'). Omit to use the session default.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the child. Defaults to the parent session cwd." }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool allowlist for the child (e.g. ['read','grep','find','ls'] for a read-only explorer). Omit to inherit the default coding toolset.",
    }),
  ),
  excludeTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tool names to deny after the allowlist (e.g. ['edit','write'])." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Abort the subagent if it runs longer than this many milliseconds. Omit for no timeout.",
    }),
  ),
  retryOnTransient: Type.Optional(
    Type.Boolean({
      description: "Retry once on a transient failure (timeout/network/rate-limit). Default true.",
    }),
  ),
  schema: Type.Optional(
    Type.Unknown({
      description:
        "JSON Schema for the subagent's final answer (e.g. {type:'object', properties:{...}}). When set, the child must return via a structured_output call matching this shape instead of prose; the tool result is the JSON-serialized object.",
    }),
  ),
});

export interface SubagentToolOptions {
  cwd?: string;
  /** Parent-session tools to bridge into the child. Updated by session_start. */
  getExtensionTools?: () => ToolDefinition[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  /** Injectable agentType registry for tests (defaults to loadAgentRegistry(cwd) per call). */
  agentRegistry?: AgentRegistry;
  /** Injectable worktree creation for tests (defaults to the real createWorktree). */
  createWorktree?: typeof createWorktree;
  /** Injectable worktree teardown for tests (defaults to the real removeWorktree). */
  removeWorktree?: typeof removeWorktree;
}

/** Minimal pre-flight check: a JSON-Schema-shaped object needs at least a `type` field. */
function isSchemaShaped(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}

/** Collapse a task prompt to a single-line preview of at most `n` chars. */
export function taskPreview(task: string, n = 80): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

/** Render the latest compact history snapshot as a one/two-line progress update. */
export function formatSubagentProgress(history: AgentHistoryEntry[], elapsedMs: number): string {
  const last = history[history.length - 1];
  const toolCalls = history.filter((h) => h.kind === "toolCall").length;
  const activity = !last
    ? "…"
    : last.kind === "toolCall"
      ? (last.toolName ?? "tool")
      : last.kind === "toolResult"
        ? `${last.toolName ?? "tool"} → done`
        : last.kind === "text"
          ? (last.text.split("\n")[0] ?? "").slice(0, 60)
          : last.text.slice(0, 60);
  const elapsedS = (elapsedMs / 1000).toFixed(1);
  return `↳ ${activity}\n  ↳ ${elapsedS}s elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
}

/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: { agent?: string; model?: string; task: string },
  theme: Theme,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  parts.push(theme.fg("muted", args.model ?? "default"));
  parts.push(theme.fg("dim", `"${taskPreview(args.task, 60)}"`));
  return parts.join(" ▸ ");
}

/** Theme the result: collapsed = badge+meta+headline; expanded = full report. */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): string {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (options.isPartial) {
    // Streaming progress update: the SDK's onUpdate contract carries no
    // `details` yet (mirrors pi-agent-ext-flux2's onProgress usage) — just
    // show the latest line.
    return theme.fg("dim", text);
  }
  const d = result.details;
  if (!d) return text;
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : theme.fg("error", "✗ failed");
  const usageStr =
    d.usage && d.usage.total > 0 ? ` · $${d.usage.cost.toFixed(3)} · ${d.usage.total} tok` : "";
  const meta = theme.fg("muted", `${d.model ?? "default"} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`);
  if (!options.expanded) {
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return `${badge} ${meta} ${theme.fg("dim", truncateToWidth(firstLine, 60))}`;
  }
  return `${badge} ${meta}\n${theme.fg("toolOutput", text)}`;
}

/** Derive a human status from the spawn result. */
export function deriveSubagentStatus(r: SpawnSubagentResult): SubagentToolDetails["status"] {
  if (r.exitCode === 0) return "done";
  return r.timedOut ? "timedout" : "failed";
}

/** Format the subagent result into the text the parent agent reads. */
export function formatSubagentResult(result: SpawnSubagentResult): string {
  if (result.exitCode === 0) return result.output;
  const fate = result.timedOut ? "timed out" : "failed";
  const head = `Subagent ${fate} (exit ${result.exitCode}).`;
  const err = result.stderr ? `\n${result.stderr}` : "";
  const tail = result.output ? `\n\n--- subagent output ---\n${result.output}` : "";
  return `${head}${err}${tail}`;
}

export function createSubagentTool(
  options: SubagentToolOptions = {},
): ToolDefinition<typeof subagentToolSchema, SubagentToolDetails> {
  const defaultCwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? spawnSubagent;
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Dispatch a single subagent with an ISOLATED context to do a focused task and report back.",
      "The subagent does NOT inherit this session's history — pass a self-contained `task` prompt.",
      "Returns the subagent's output, plus an exit/timed-out status in `details`.",
    ].join(" "),
    promptSnippet:
      "Dispatch an isolated-context subagent for one focused task (implementer / reviewer / researcher). Pass a self-contained `task`; choose `model` per role; restrict with `tools`/`excludeTools`.",
    parameters: subagentToolSchema,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const t0 = Date.now();
      const runCwd = params.cwd ?? defaultCwd;
      const makeWorktree = options.createWorktree ?? createWorktree;
      const teardownWorktree = options.removeWorktree ?? removeWorktree;

      const failEarly = (text: string): { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails } => ({
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: 1,
          timedOut: false,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          status: "failed",
        },
      });

      let agentDef: AgentDefinition | undefined;
      if (params.agentType) {
        const registry = options.agentRegistry ?? loadAgentRegistry(runCwd);
        agentDef = resolveAgentType(params.agentType, registry);
        if (!agentDef) {
          const known = listAgentTypes(registry).map((t) => t.name);
          return failEarly(
            `Unknown agentType "${params.agentType}".${
              known.length
                ? ` Available: ${known.join(", ")}.`
                : " No agentType definitions found (.pi/agents/*.md or ~/.pi/agents/*.md)."
            }`,
          );
        }
      }

      if (params.schema !== undefined && !isSchemaShaped(params.schema)) {
        return failEarly(`Invalid schema: expected a JSON-Schema-shaped object with a "type" field.`);
      }

      let worktree: Worktree | undefined;
      let spawnCwd = runCwd;
      if (agentDef?.isolation === "worktree") {
        // toolCallId (not runId+callIndex) is fine here: this tool has no resume/journal
        // semantics, unlike workflow.ts's agent() — see the determinism note on
        // createWorktree() in worktree.ts.
        worktree = await makeWorktree(runCwd, `subagent-${toolCallId}`);
        if (worktree.isolated) spawnCwd = worktree.cwd;
      }

      try {
        const instructions =
          [params.agent ? `You are the ${params.agent} for this task.` : undefined, agentDef?.prompt]
            .filter((s): s is string => Boolean(s))
            .join("\n\n") || undefined;

        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: params.model ?? agentDef?.model,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: signal,
          timeoutMs: params.timeoutMs,
          retryOnTransient: params.retryOnTransient,
          schema: params.schema as TSchema | undefined,
          onHistory: onUpdate
            ? (history: AgentHistoryEntry[]) => {
                // Progress streaming is diagnostic only — a throwing onUpdate
                // (e.g. a TUI re-render failure) must never fail the subagent's
                // actual task result.
                try {
                  onUpdate({
                    content: [{ type: "text" as const, text: formatSubagentProgress(history, Date.now() - t0) }],
                    details: undefined as unknown as SubagentToolDetails,
                  });
                } catch {
                  // swallowed — see comment above
                }
              }
            : undefined,
        });
        return {
          content: [{ type: "text" as const, text: formatSubagentResult(result) }],
          details: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            agent: params.agent,
            model: params.model ?? agentDef?.model ?? "default",
            taskPreview: taskPreview(params.task),
            elapsedMs: Date.now() - t0,
            status: deriveSubagentStatus(result),
            usage: result.usage,
          },
        };
      } finally {
        if (worktree) await teardownWorktree(worktree);
      }
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, _context) {
      const text = (_context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, theme));
      return text;
    },
  });
}
