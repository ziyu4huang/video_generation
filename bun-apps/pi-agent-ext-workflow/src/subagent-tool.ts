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
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  spawnSubagent,
  type SpawnSubagentOptions,
  type SpawnSubagentResult,
} from "./spawn-subagent.js";

export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
}

export const subagentToolSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Informational role/label for the subagent (e.g. 'implementer', 'reviewer', 'researcher'). Forwarded as an instructions prefix; does not change tool selection.",
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
});

export interface SubagentToolOptions {
  cwd?: string;
  /** Parent-session tools to bridge into the child. Updated by session_start. */
  getExtensionTools?: () => ToolDefinition[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
        externalSignal: signal,
      });
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(result) }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
  });
}
