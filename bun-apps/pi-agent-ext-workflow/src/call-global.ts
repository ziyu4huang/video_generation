/**
 * `buildCallGlobal(deps)` — the pure, fully-injected factory behind the workflow
 * runtime's `call('ns.name', args)` global (sub-project ②).
 *
 * Deterministic, journaled, zero-token. Mirrors `checkpoint()`'s journaling +
 * maxAgents accounting exactly; differs in that (a) the value comes from a
 * registered host fn instead of a human, and (b) it does NOT flow through the
 * concurrency limiter (local compute, awaited inline — also like checkpoint).
 *
 * Every dependency is injected so every behavior is unit-testable without
 * `runWorkflow`. `src/workflow.ts` wires real deps + injects `call` into the
 * `vm.createContext` sandbox.
 */

import { isWorkflowError, WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import { hashHostCall, runHostFnWithTimeout } from "./host-fn-helpers.js";
import type { HostFnAskOptions, HostFnRegistry } from "./host-fn-registry.js";

export interface JournalEntryLike {
  index: number;
  hash: string;
  result: unknown;
}
export interface AgentStartEventLike {
  callIndex: number;
  label: string;
  phase: string;
  prompt: string;
  model: string;
}
export interface AgentEndEventLike {
  callIndex: number;
  label: string;
  phase: string;
  result: unknown;
  tokens: number;
  model: string;
}

export interface CallDeps {
  hostFns: HostFnRegistry | undefined;
  state: { callSeq: number; firstMiss: number; currentPhase?: string };
  shared: { agentCount: number };
  maxAgents: number;
  options: {
    resumeJournal?: Map<number, JournalEntryLike>;
    onAgentJournal?: (e: JournalEntryLike) => void;
    onAgentStart?: (e: AgentStartEventLike) => void;
    onAgentEnd?: (e: AgentEndEventLike) => void;
    cwd?: string;
    signal?: AbortSignal;
    /**
     * UI-bearing ask callback threaded from the workflow's confirm() (the same
     * one checkpoint() uses). When present it becomes HostFnCtx.ask so a host-fn
     * can ask the human mid-flow; absent (undefined) in headless runs. */
    ask?: (promptText: string, options?: HostFnAskOptions) => Promise<unknown>;
  };
  runId: string;
  throwIfAborted: () => void;
  /**
   * Production leaves this undefined — `call()` bypasses the concurrency limiter
   * (local compute). A test injects a spy to assert the limiter is NOT invoked.
   * The factory body never calls this field; its presence is the assertion hook.
   */
  limiter?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const HOST_FN_MODEL = "(host-fn)";

export function buildCallGlobal(deps: CallDeps): (namespaced: unknown, args?: unknown) => Promise<unknown> {
  const phase = () => deps.state.currentPhase ?? "";
  return async (namespaced, args) => {
    deps.throwIfAborted();
    if (typeof namespaced !== "string" || !namespaced.includes(".")) {
      throw new TypeError("call('ns.name', args) needs a 'ns.name' string");
    }
    // Bounded-work guard — mirrors checkpoint() exactly (workflow.ts maxAgents check).
    if (deps.shared.agentCount >= deps.maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${deps.maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const entry = deps.hostFns?.get(namespaced);
    if (!entry) {
      throw new WorkflowError(`host fn '${namespaced}' is not registered`, WorkflowErrorCode.HOST_FN_UNKNOWN, {
        recoverable: false,
        agentLabel: namespaced,
      });
    }
    const callIndex = deps.state.callSeq++;
    const callHash = hashHostCall(namespaced, args);
    const cached = deps.options.resumeJournal?.get(callIndex);
    if (cached != null && cached.hash === callHash && callIndex < deps.state.firstMiss) {
      deps.shared.agentCount++;
      deps.options.onAgentStart?.({ callIndex, label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });
      deps.options.onAgentEnd?.({
        callIndex,
        label: namespaced,
        phase: phase(),
        result: cached.result,
        tokens: 0,
        model: HOST_FN_MODEL,
      });
      return cached.result;
    }
    if (cached == null || cached.hash !== callHash) {
      deps.state.firstMiss = Math.min(deps.state.firstMiss, callIndex);
    }
    deps.shared.agentCount++;
    deps.options.onAgentStart?.({ callIndex, label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });

    // NOT routed through the concurrency limiter — local compute, awaited inline.
    // (The optional deps.limiter is an assertion hook only; it is intentionally
    // never called here. agent() routes through limiter; call() does not.)
    let result: unknown;
    try {
      result = await runHostFnWithTimeout(
        entry,
        args,
        {
          cwd: deps.options.cwd ?? process.cwd(),
          signal: deps.options.signal ?? new AbortController().signal,
          runId: deps.runId,
          ask: deps.options.ask,
        },
        namespaced,
      );
    } catch (e) {
      if (isWorkflowError(e)) throw e;
      throw new WorkflowError(
        `host fn '${namespaced}' failed: ${e instanceof Error ? e.message : String(e)}`,
        WorkflowErrorCode.HOST_FN_FAILED,
        { recoverable: false, agentLabel: namespaced, details: e },
      );
    }
    deps.throwIfAborted();
    deps.options.onAgentJournal?.({ index: callIndex, hash: callHash, result });
    deps.options.onAgentEnd?.({
      callIndex,
      label: namespaced,
      phase: phase(),
      result,
      tokens: 0,
      model: HOST_FN_MODEL,
    });
    return result;
  };
}
