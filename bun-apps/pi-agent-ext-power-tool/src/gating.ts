/**
 * gating.ts — the one tool-gate predicate every inspect_* tool shares.
 *
 * All six diagnostics answer the same class of request ("what is loaded / where do
 * the tokens go / how is the agent failing"), so they gate identically. This used to
 * be an eight-line literal copy-pasted into all six tool modules; a keyword added to
 * one copy silently left the other five behind. `pi-agent-ext-tool-gate`'s QA probes
 * (see `extensions/power-tool.ts` `__GATE_PROBES__`) assert against this predicate,
 * so there must be exactly one of it.
 */

/**
 * Shared gate for the inspect_* diagnostics suite — pass straight to
 * `defineTool({ gating })`.
 *
 * Deliberately NOT `as const`: the SDK's `Gating` type takes mutable `string[]`,
 * and a readonly literal fails to assign.
 */
export const DIAGNOSTIC_GATING: {
  keywords: string[];
  requires: { nouns: string[]; verbs: string[] };
} = {
  keywords: ["schema cost", "pathology", "extension health", "工具開銷", "context window", "token usage"],
  requires: {
    nouns: ["agent", "context", "extension", "pathology", "token", "schema", "tui", "工具"],
    verbs: ["inspect", "show", "check", "diagnose", "dump", "report"],
  },
};
