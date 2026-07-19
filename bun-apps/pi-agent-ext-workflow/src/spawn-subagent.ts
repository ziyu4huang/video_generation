/**
 * `spawnSubagent()` — a thin shared wrapper over `WorkflowAgent.run` (in-process
 * `createAgentSession`) exposed for non-workflow callers (sub-project ①:
 * knowledge-card's `zk_card` / `zk_ask` migrate here off pi-obsidian's child-
 * process `runSubagentWithRetry`).
 *
 * The return shape MIRRORS `runSubagentWithRetry` (`{output, exitCode, stderr,
 * timedOut}`) so callers change one line and their result-handling stays
 * byte-identical. `WorkflowAgent.run` returns a string or throws, so this helper
 * ADAPTS success/throw into that shape, classifies transient failures (timeout /
 * abort / network) for the single retry, and accepts an injectable `agent` runner
 * for unit testing without a real session.
 *
 * `prime?` is a no-op forward-reference to sub-project ③ (auto-primer). `extensionTools?`
 * is the R2 bridge (Phase-1 finding): parent-session tools threaded into the child so
 * obsidian tools reach it in BOTH manifest-installed and `-e` dev mode.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { WorkflowAgent, type AgentUsage } from "./agent.js";
import { isWorkflowError, WorkflowErrorCode } from "./errors.js";

export interface SpawnSubagentPrime {
  query: string;
  topK?: number;
  folder?: string;
}

export interface SpawnSubagentOptions {
  task: string;
  /** Curated tool allowlist (obsidian tool names for zk_*). */
  tools?: string[];
  /** Tool names to deny after the allowlist. */
  excludeTools?: string[];
  model?: string;
  schema?: TSchema;
  instructions?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Retry once on a transient (timeout/abort/network) failure. Default true. */
  retryOnTransient?: boolean;
  /** Forward-ref to ③ — accepted but does NOT retrieve or alter output. */
  prime?: SpawnSubagentPrime;
  /** Parent-session tools to bridge into the child (R2). */
  extensionTools?: ToolDefinition[];
  /** Injectable runner (tests pass a mock; production omits → new WorkflowAgent). */
  agent?: Pick<WorkflowAgent, "run">;
  /** Host signal (e.g. tool-call Ctrl+C) that should cancel this call when fired. */
  externalSignal?: AbortSignal;
}

export interface SpawnSubagentResult {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  /** Real token/cost usage read from the child session, when the runner reports it. */
  usage?: AgentUsage;
}

const TRANSIENT_NETWORK_RE =
  /econnreset|econnrefused|enotfound|socket hang up|rate.?limit|429|503|502|network|fetch failed|eai_again/i;

interface ErrorClass {
  transient: boolean;
  timedOut: boolean;
  message: string;
}

function classifyError(e: unknown): ErrorClass {
  const message = e instanceof Error ? e.message : String(e);
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.AGENT_TIMEOUT) {
    return { transient: true, timedOut: true, message };
  }
  // A signal abort (from our timeoutMs gate) looks like an AbortError.
  if (e instanceof Error && /\babort/i.test(e.name) && /\babort/i.test(message)) {
    return { transient: true, timedOut: true, message };
  }
  if (TRANSIENT_NETWORK_RE.test(message)) {
    return { transient: true, timedOut: false, message };
  }
  return { transient: false, timedOut: false, message };
}

export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> {
  const runner = opts.agent ?? new WorkflowAgent({ cwd: opts.cwd, extensionTools: opts.extensionTools });
  const retry = opts.retryOnTransient !== false;

  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort();
      else opts.externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    let usage: AgentUsage | undefined;
    try {
      // `prime` is intentionally NOT used here (③ owns the auto-primer).
      const out = await runner.run(opts.task, {
        label: "zk-spawn",
        schema: opts.schema,
        instructions: opts.instructions,
        model: opts.model,
        toolNames: opts.tools,
        disallowedToolNames: opts.excludeTools,
        cwd: opts.cwd,
        signal: ac.signal,
        onUsage: (u) => {
          usage = u;
        },
      } as Parameters<WorkflowAgent["run"]>[1]);
      // When `opts.schema` is set, `run()` returns a validated OBJECT (not a
      // string). `String(obj)` would yield "[object Object]" and silently
      // destroy the schema payload — JSON-serialize it instead so callers
      // that parse `output` keep working. Null/undefined → empty string.
      const output = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      return { result: { output, exitCode: 0, stderr: "", timedOut: false, usage }, transient: false };
    } catch (e) {
      const c = classifyError(e);
      return {
        result: { output: "", exitCode: c.timedOut ? 124 : 1, stderr: c.message, timedOut: c.timedOut, usage },
        transient: c.transient,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const first = await tryOnce();
  if (first.result.exitCode === 0 || !retry || !first.transient) return first.result;
  // Never retry a cancel the caller (or user) explicitly requested — retrying
  // would re-run work that was just aborted.
  if (opts.externalSignal?.aborted) return first.result;
  // Single retry on a transient failure (mirrors runSubagentWithRetry).
  return (await tryOnce()).result;
}
