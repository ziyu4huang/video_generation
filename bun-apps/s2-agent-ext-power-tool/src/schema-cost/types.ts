/**
 * Type definitions for the schema-cost submodule.
 *
 * These mirror the `inspect_context` live instrument's types exactly (this
 * submodule IS the extraction of that pure core), so delegation is a drop-in.
 */

/** A single tool's measured schema-token cost. */
export interface ToolCost {
	/** Tool name (from `definition.name`). */
	name: string;
	/** Description string length (chars). */
	descLen: number;
	/** JSON-stringified TypeBox parameters schema length (chars). */
	paramsLen: number;
	/** Estimated tokens: round((descLen + paramsLen) / charsPerToken). */
	approxTokens: number;
	/** Where the tool came from: "(builtin)" or the extension source label. */
	source: string;
	/** Contract: `definition.execute` is a function. Omitted when unchecked. */
	hasExecute?: boolean;
	/** Contract: `parameters` is a valid constructible schema. Omitted when unchecked. */
	schemaValid?: boolean;
}

/** The full ranked report produced by {@link analyzeTools}. */
export interface SchemaCostReport {
	/** Tools sorted desc by approxTokens, tie-broken by name. */
	tools: ToolCost[];
	/** Sum of every tool's approxTokens. */
	totalTokens: number;
	/** Count of tools whose source is "(builtin)". */
	builtinCount: number;
	/** Count of non-builtin tools. */
	extensionCount: number;
	/** Per-extension load failures (collection-time only; empty from analyzeTools). */
	errors: { source: string; error: string }[];
}

/** Options for token estimation + analysis. */
export interface AnalyzeOptions {
	/**
	 * Chars-per-token ratio for the heuristic estimate. Default **4** (the
	 * standard ~4-chars-per-token approximation for English text + JSON; matches
	 * the static `schema-cost` CLI instrument). The live `inspect_context`
	 * uses 3.7 — pass `3.7` here to reproduce its numbers. It's an ESTIMATE:
	 * real cost depends on the provider's tokenizer, but it ranks tools
	 * correctly and is deterministic + offline.
	 *
	 * @default 4
	 */
	charsPerToken?: number;
}

/** A minimal tool definition shape (duck-typed; works with pi's ToolDefinition). */
export interface ToolDefinitionLike {
	name?: string;
	description?: unknown;
	parameters?: unknown;
	/** The tool's handler (`ToolDefinition.execute`). Duck-typed for contract checks. */
	execute?: unknown;
}
