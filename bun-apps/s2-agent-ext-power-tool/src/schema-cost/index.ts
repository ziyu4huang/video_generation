/**
 * schema-cost — public API (submodule of @repo/s2-agent-ext-power-tool).
 *
 * Measure and rank the API schema-token cost of LLM tool definitions.
 * Pure token-accounting + per-tool schema-cost. Zero runtime deps.
 *
 * @example
 *   import { estimateToolCost, analyzeTools, formatReport } from "@repo/s2-agent-ext-power-tool/schema-cost";
 *
 *   const tools = [{ name: "read", description: "Read a file.", parameters: { type: "object" } }];
 *   const report = analyzeTools(tools, "(builtin)");
 *   console.log(formatReport(report).join("\n"));
 */
export {
	estimateTokens,
	estimateToolCost,
	analyzeTools,
	mergeReports,
	DEFAULT_CHARS_PER_TOKEN,
} from "./estimate.ts";
export { formatReport, formatJson } from "./format.ts";
export { checkToolContract } from "./contract.ts";
export type { ToolContract } from "./contract.ts";
export type {
	ToolCost,
	SchemaCostReport,
	AnalyzeOptions,
	ToolDefinitionLike,
} from "./types.ts";
