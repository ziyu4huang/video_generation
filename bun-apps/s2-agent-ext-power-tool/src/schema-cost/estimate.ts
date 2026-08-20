/**
 * Pure schema-token-cost estimation. The unit-testable, dependency-free core.
 *
 * Every LLM tool-call request repeats each tool's `description` + the JSON
 * Schema of its `parameters` in the API `tools` array. That schema text is a
 * per-request token tax — the #1 demand bucket for context-window cost. This
 * module measures it so tools can be ranked, baselined, and (selectively)
 * reduced.
 */
import type { AnalyzeOptions, SchemaCostReport, ToolCost, ToolDefinitionLike } from "./types.ts";

/** The default chars-per-token ratio (≈4 for English + JSON). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a string via the chars-per-token heuristic.
 * Pure + deterministic. Pass a `charsPerToken` (e.g. `3.7`) to reproduce a
 * different instrument's numbers.
 *
 * @example estimateTokens("hello world") // → 3 (round(11/4))
 */
export function estimateTokens(chars: number, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
	return Math.round(chars / charsPerToken);
}

/**
 * Estimate the API schema-token cost of a single tool definition.
 * Pure + deterministic. `source` labels the origin ("(builtin)" or an
 * extension name) so reports can be grouped.
 *
 * @example
 *   estimateToolCost({ name: "read", description: "Read a file.", parameters: { type: "object" } }, "(builtin)")
 *   // → { name: "read", descLen: 12, paramsLen: 21, approxTokens: 8, source: "(builtin)" }
 */
export function estimateToolCost(
	def: ToolDefinitionLike | unknown,
	source: string,
	opts: AnalyzeOptions = {},
): ToolCost {
	const d = (def ?? {}) as ToolDefinitionLike;
	const name = typeof d.name === "string" ? d.name : "?";
	const desc = typeof d.description === "string" ? d.description : "";
	const paramsObj = d.parameters;
	const paramsLen = paramsObj && typeof paramsObj === "object" ? JSON.stringify(paramsObj).length : 0;
	const ratio = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	return {
		name,
		descLen: desc.length,
		paramsLen,
		approxTokens: Math.round((desc.length + paramsLen) / ratio),
		source,
	};
}

/**
 * Analyze a list of pre-collected tool definitions into a ranked report.
 *
 * This is the pure half: it does NOT discover or load tools (that's the
 * s2-agent-coupled collection half that stays in s2-agent). Feed it whatever tool
 * definitions you have — from a pi extension mock-capture, from an OpenAI
 * client, from a static fixture — and it ranks them by schema-token cost.
 *
 * @example
 *   const report = analyzeTools([{name:"a",description:"x",parameters:{}}, ...], "(test)");
 *   report.tools[0] // the most expensive tool
 *   report.totalTokens // the full per-request schema tax
 */
export function analyzeTools(
	tools: (ToolDefinitionLike | unknown)[],
	source: string,
	opts: AnalyzeOptions = {},
): SchemaCostReport {
	const costs = tools.map((t) => estimateToolCost(t, source, opts));
	costs.sort((a, b) => b.approxTokens - a.approxTokens || a.name.localeCompare(b.name));
	return {
		tools: costs,
		totalTokens: costs.reduce((s, t) => s + t.approxTokens, 0),
		builtinCount: 0, // analyzeTools is source-agnostic; set by callers if needed
		extensionCount: costs.length,
		errors: [],
	};
}

/**
 * Merge multiple per-source reports (or ToolCost lists) into one ranked report.
 * Use this when you collect tools from several origins (built-ins +
 * extensions) and want a single consolidated ranking. Counts built-ins by the
 * "(builtin)" source convention.
 */
export function mergeReports(reports: ToolCost[][]): SchemaCostReport {
	const all = reports.flat();
	all.sort((a, b) => b.approxTokens - a.approxTokens || a.name.localeCompare(b.name));
	return {
		tools: all,
		totalTokens: all.reduce((s, t) => s + t.approxTokens, 0),
		builtinCount: all.filter((t) => t.source === "(builtin)").length,
		extensionCount: all.length - all.filter((t) => t.source === "(builtin)").length,
		errors: [],
	};
}
