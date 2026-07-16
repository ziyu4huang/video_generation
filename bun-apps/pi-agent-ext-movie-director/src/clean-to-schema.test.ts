import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanToSchema } from "./clean-to-schema.ts";
import { validateArtifact } from "./schema.ts";

/** Load a bundled artifact schema as a parsed object (tests may use fs; the core fn may not). */
function loadSchema(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(import.meta.dir, "..", "data", "schemas", "artifacts", `${name}.schema.json`), "utf8"));
}

/** A complete, schema-valid proposal_packet (the smallest real fixture covering every strict nest). */
function validProposalPacket(): Record<string, unknown> {
	return {
		version: "1.0",
		concept_options: [
			{ id: "c1", title: "Light bent by rain", hook: "Why does a rainbow arc?", narrative_structure: "analogy", visual_approach: "Particle sim", target_duration_seconds: 90, why_this_works: "Grounded in refraction" },
			{ id: "c2", title: "Forty-two degrees", hook: "It's always the same angle", narrative_structure: "data_narrative", visual_approach: "Diagram", target_duration_seconds: 80, why_this_works: "Geometry is memorable" },
			{ id: "c3", title: "A spectrum walk", hook: "Each color bends differently", narrative_structure: "journey", visual_approach: "Prism split", target_duration_seconds: 70, why_this_works: "Spectrum is visual" },
		],
		selected_concept: { concept_id: "c1", rationale: "Most grounded" },
		production_plan: {
			pipeline: "animated-explainer",
			stages: [
				{ stage: "assets", tools: [{ tool_name: "ltx", role: "I2V clips", available: true }], approach: "Chain I2V" },
			],
			render_runtime: "ffmpeg",
		},
		cost_estimate: {
			total_estimated_usd: 0,
			line_items: [{ tool: "ltx", operation: "I2V", estimated_usd: 0 }],
			budget_verdict: "no_budget_set",
		},
		approval: { status: "approved", user_notes: "go", approved_budget_usd: 0 },
	};
}

/** The same packet with stray fields injected at every additionalProperties:false nest. */
function dirtyProposalPacket(): Record<string, unknown> {
	const p = validProposalPacket();
	(p as Record<string, unknown>).stray_top = "should be stripped"; // top-level additionalProperties:false
	(p.approval as Record<string, unknown>).approved_by = "alice"; // /approval extra — THE real failure
	(p.approval as Record<string, unknown>).timestamp = "2026-07-14";
	((p.concept_options as Record<string, unknown>[])[0]!).badge = "gold"; // array-item strict object extra
	(p.cost_estimate as Record<string, unknown>).note = "extra"; // cost_estimate strict object extra
	(p.production_plan as Record<string, unknown>).whimsy = "no"; // production_plan strict object extra
	return p;
}

test("proposal_packet: strips unknown /approval sub-fields — the real failure reproducer", () => {
	const schema = loadSchema("proposal_packet");
	const dirty = dirtyProposalPacket();

	// The dirty packet FAILS validation (additionalProperties on approval / top / nests).
	const before = validateArtifact("proposal_packet", dirty);
	expect(before.ok).toBe(false);

	// cleanToSchema strips every stray field at every strict nest.
	const cleaned = cleanToSchema(schema, dirty) as Record<string, unknown>;
	expect(Object.keys(cleaned).sort()).toEqual(
		["approval", "concept_options", "cost_estimate", "production_plan", "selected_concept", "version"].sort(),
	);
	expect(Object.keys(cleaned.approval as object).sort()).toEqual(
		["approved_budget_usd", "status", "user_notes"].sort(),
	);
	expect((cleaned.approval as Record<string, unknown>).approved_by).toBeUndefined();
	expect((cleaned.approval as Record<string, unknown>).timestamp).toBeUndefined();
	expect(((cleaned.concept_options as Record<string, unknown>[])[0]!).badge).toBeUndefined();
	expect((cleaned.cost_estimate as Record<string, unknown>).note).toBeUndefined();
	expect((cleaned.production_plan as Record<string, unknown>).whimsy).toBeUndefined();

	// The cleaned packet now PASSES validation against the canonical schema.
	const after = validateArtifact("proposal_packet", cleaned);
	expect(after.ok).toBe(true);
});

test("nested object with additionalProperties:false drops extras recursively (inline schema)", () => {
	const schema = {
		type: "object",
		properties: {
			outer: {
				type: "object",
				additionalProperties: false,
				properties: { a: { type: "string" }, inner: { type: "object", additionalProperties: false, properties: { x: { type: "number" } } } },
			},
		},
	};
	const dirty = { outer: { a: "hi", stray: "drop", inner: { x: 1, junk: "drop" } } };
	const cleaned = cleanToSchema(schema, dirty) as { outer: { a: string; inner: { x: number } } };
	expect(cleaned.outer).toEqual({ a: "hi", inner: { x: 1 } });
	expect((cleaned.outer as Record<string, unknown>).stray).toBeUndefined();
	expect((cleaned.outer.inner as Record<string, unknown>).junk).toBeUndefined();
});

test("additionalProperties:true (or absent) objects are NOT stripped — only false strips", () => {
	// metadata in proposal_packet is { type: "object" } with no properties — must pass through intact.
	const schema = { type: "object", properties: { metadata: { type: "object" } } };
	const dirty = { metadata: { anything: 1, goes: true } };
	const cleaned = cleanToSchema(schema, dirty) as { metadata: Record<string, unknown> };
	expect(cleaned.metadata).toEqual({ anything: 1, goes: true });
});

test("coerces stringified number/boolean/integer to native when the schema wants that type", () => {
	const schema = {
		type: "object",
		properties: {
			n: { type: "number" },
			i: { type: "integer" },
			b: { type: "boolean" },
		},
	};
	const cleaned = cleanToSchema(schema, { n: "12.5", i: "7", b: "true" }) as { n: number; i: number; b: boolean };
	expect(cleaned.n).toBe(12.5);
	expect(typeof cleaned.n).toBe("number");
	expect(cleaned.i).toBe(7);
	expect(Number.isInteger(cleaned.i)).toBe(true);
	expect(cleaned.b).toBe(true);
	expect(typeof cleaned.b).toBe("boolean");

	const cleanedFalse = cleanToSchema(schema, { n: 0, i: 0, b: "false" }) as { b: boolean };
	expect(cleanedFalse.b).toBe(false);
});

test("array items are cleaned against schema.items (recursive)", () => {
	const schema = {
		type: "object",
		properties: {
			items: {
				type: "array",
				items: { type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
			},
		},
	};
	const dirty = { items: [{ id: "a", junk: 1 }, { id: "b", junk: 2 }] };
	const cleaned = cleanToSchema(schema, dirty) as { items: Record<string, unknown>[] };
	expect(cleaned.items).toEqual([{ id: "a" }, { id: "b" }]);
});

test("passthrough unchanged when schema is undefined (no-op)", () => {
	const data = { anything: 1, nested: { deep: true }, arr: [1, 2] };
	expect(cleanToSchema(undefined, data)).toBe(data);
	expect(cleanToSchema(undefined, "raw string")).toBe("raw string");
	expect(cleanToSchema(undefined, 42)).toBe(42);
});

test("non-numeric / non-boolean strings are NOT coerced (left for validation to flag)", () => {
	const schema = { type: "object", properties: { n: { type: "number" }, b: { type: "boolean" } } };
	const cleaned = cleanToSchema(schema, { n: "abc", b: "maybe" }) as { n: unknown; b: unknown };
	expect(cleaned.n).toBe("abc"); // left as-is — not a valid number, validation will catch it
	expect(cleaned.b).toBe("maybe");
});
