/**
 * cost.ts — the ONE tool-schema cost measurement the inspect_* tools use.
 *
 * A tool's per-request API tax is `description` + `JSON.stringify(parameters)`, and
 * `schema-cost/` already owns that formula for four consumers outside this package
 * (s2-agent's schema-cost CLI, s2-agent-ext-tool-gate x3). This module is the thin
 * adapter that lets the LIVE instruments reuse it instead of re-deriving it.
 *
 * They used to re-derive it: the formula was inlined in four places while only the
 * chars-per-token RATIO was shared, and the two halves had already drifted — a tool
 * with `parameters: undefined` measured 2 chars inline (`JSON.stringify({})`) and 0
 * chars in schema-cost. A diagnostics package that disagrees with itself is worse
 * than no diagnostics, so the formula lives in exactly one place now: keep it there.
 */
import { estimateToolCost } from "./schema-cost/index.ts";

/** The per-request API schema cost of one tool, split so reports can show the parts. */
export interface ToolApiCost {
  /** `description` length in chars. */
  descChars: number;
  /** `JSON.stringify(parameters)` length in chars — 0 when parameters is not an object. */
  paramsChars: number;
  /** descChars + paramsChars — what the API `tools[]` array carries, every request. */
  apiChars: number;
  /** apiChars at schema-cost's canonical chars-per-token ratio. */
  tokens: number;
}

/**
 * Measure one tool's API schema cost. Accepts anything with the ToolInfo shape
 * (`ToolInfo`, an `AnalysisTool`, a fixture) — only `description` and `parameters`
 * are read.
 */
export function toolApiCost(tool: { description?: string; parameters?: unknown }): ToolApiCost {
  const c = estimateToolCost(tool, "");
  return {
    descChars: c.descLen,
    paramsChars: c.paramsLen,
    apiChars: c.descLen + c.paramsLen,
    tokens: c.approxTokens,
  };
}
