/**
 * clean-to-schema.ts — deterministic safety net between LLM output and strict
 * JSON-Schema validation.
 *
 * Creative waypoints (proposal/script/scene_plan/edit) produce one artifact each;
 * their canonical schemas use `additionalProperties:false` on nested objects, so a
 * model that adds a stray field (e.g. `/approval.approved_by`) fails validation
 * even when the rest of the artifact is correct — and can't always self-correct
 * within the bounded retry budget (the real `proposal` stall, 2026-07-13).
 *
 * `cleanToSchema` deterministically shapes LLM output to a schema BEFORE
 * validation runs, WITHOUT inventing content (no field filling): it
 *   • strips properties absent from the schema where `additionalProperties:false`,
 *   • recurses into declared object properties + array items,
 *   • light-coerces stringified number/integer/boolean scalars to native types.
 *
 * The LLM still does all the creative work; this only trims shape mismatches the
 * model can't see. Pure: schema + data in, cleaned data out — no fs, no side effects.
 */

/** A minimal JSON-Schema subset this cleaner reasons about. */
interface SchemaLike {
	type?: string | string[];
	properties?: Record<string, SchemaLike>;
	additionalProperties?: boolean | SchemaLike;
	items?: SchemaLike;
	required?: string[];
}

function schemaTypes(s: SchemaLike): string[] {
	return Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
}

/** Coerce a scalar string to the native type a schema asks for (best-effort, never invents). */
function coerceScalar(types: string[], data: unknown): unknown {
	if (typeof data !== "string") return data;
	if ((types.includes("number") || types.includes("integer")) && data.trim() !== "" && !Number.isNaN(Number(data))) {
		return Number(data);
	}
	if (types.includes("boolean") && (data === "true" || data === "false")) {
		return data === "true";
	}
	return data;
}

/**
 * Recursively clean `data` to conform to `schema`:
 *   - undefined schema → passthrough (no-op)
 *   - scalar coercion (stringified number/integer/boolean → native)
 *   - object: where additionalProperties is false, keep ONLY declared properties
 *             and recurse into each; otherwise keep all keys but still recurse
 *             into declared ones; a bare object (no properties) passes through
 *   - array: clean each item against schema.items
 * Non-conforming shapes (e.g. object where a string is wanted) are left for the
 * validator to flag — this never fabricates structure.
 */
export function cleanToSchema(schema: Record<string, unknown> | undefined, data: unknown): unknown {
	if (!schema || typeof schema !== "object") return data;
	const s = schema as unknown as SchemaLike;

	// Scalar coercion (only when data is a primitive the schema describes as a scalar).
	const types = schemaTypes(s);
	if (types.length > 0 && !Array.isArray(data) && (typeof data !== "object" || data === null)) {
		return coerceScalar(types, data);
	}

	// Object handling.
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const props = s.properties;
		// A bare object schema (no declared properties) → passthrough intact.
		if (!props) return data;
		const stripUnknown = s.additionalProperties === false;
		const src = data as Record<string, unknown>;
		if (stripUnknown) {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(src)) {
				if (k in props) out[k] = cleanToSchema(props[k] as Record<string, unknown>, src[k]);
			}
			return out;
		}
		// additionalProperties allowed (true/absent): keep all keys, recurse declared ones.
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(src)) {
			out[k] = k in props ? cleanToSchema(props[k] as Record<string, unknown>, src[k]) : src[k];
		}
		return out;
	}

	// Array handling: clean each item against schema.items.
	if (Array.isArray(data) && s.items) {
		return data.map((item) => cleanToSchema(s.items as Record<string, unknown>, item));
	}

	return data;
}
