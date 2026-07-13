/**
 * Tool contract checks — does a tool definition satisfy the deployable contract
 * BEYOND name/description? Two fields that schema-cost doesn't otherwise look at:
 *
 *   - `execute`: the tool's handler (`ToolDefinition.execute`). Missing or
 *     non-function → the tool silently no-ops at runtime (nothing today checks
 *     a *tool*'s handler — `extension-contract` checks *command* handlers only).
 *   - `parameters`: a valid, constructible schema. Malformed → the API rejects
 *     the tool or the model miscalls it (nobody validates this today).
 *
 * `Value.Create(schema)` throws iff the schema is malformed / unconstructible —
 * a lightweight, input-free validity bar. It does NOT claim the schema is
 * "sensible" (e.g. that required fields have defaults), only that it is a valid
 * constructible schema — sufficient for a regression gate.
 *
 * Never throws: malformed input yields `{ hasExecute: false, schemaValid: false }`.
 */
import { Value } from "typebox/value";
import type { ToolDefinitionLike } from "./types.ts";

/** Per-tool contract verdict. */
export interface ToolContract {
	/** `definition.execute` is a function. */
	hasExecute: boolean;
	/** `definition.parameters` is a valid constructible schema. */
	schemaValid: boolean;
}

/**
 * Check a tool definition's contract. Pure + deterministic for a given def
 * (TypeBox `Value.Create` is deterministic). Never throws.
 */
export function checkToolContract(def: ToolDefinitionLike | unknown): ToolContract {
	const d = (def ?? {}) as ToolDefinitionLike;
	const hasExecute = typeof (d as { execute?: unknown }).execute === "function";
	let schemaValid = false;
	const params = d.parameters;
	if (params && typeof params === "object") {
		try {
			Value.Create(params as Record<PropertyKey, unknown>);
			schemaValid = true;
		} catch {
			schemaValid = false;
		}
	}
	return { hasExecute, schemaValid };
}
