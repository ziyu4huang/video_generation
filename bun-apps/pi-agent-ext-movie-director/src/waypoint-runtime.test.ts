/**
 * waypoint-runtime.test.ts — the REAL producer backing (readSchemaSpec shape).
 * The session spawn itself is env-coupled (covered by the run-pipeline integration
 * test with an injected runSession); here we only assert the prompt-shape helpers
 * that are pure over the bundled schemas.
 */
import { test, expect } from "bun:test";
import { makeRealWaypointDeps } from "./waypoint-runtime.ts";

test("readSchemaSpec lists top-level required fields", () => {
	const spec = makeRealWaypointDeps({}).schemaSpec!("proposal_packet")!;
	expect(spec).toContain("approval");
	expect(spec).toContain("concept_options");
	expect(spec).toContain("production_plan");
});

test("readSchemaSpec walks ONE level into nested object properties (approval's sub-fields)", () => {
	const spec = makeRealWaypointDeps({}).schemaSpec!("proposal_packet")!;
	// approval is { status, user_notes, approved_budget_usd } — the model must see
	// these EXACT allowed sub-fields so it doesn't invent e.g. approved_by.
	expect(spec).toContain("approved_budget_usd");
	expect(spec).toContain("user_notes");
	expect(spec).toContain("status");
});

test("readSchemaSpec returns undefined for an unknown artifact (no throw)", () => {
	expect(makeRealWaypointDeps({}).schemaSpec!("does_not_exist_xyz")).toBeUndefined();
});

test("readSchemaSpec surfaces nested array-item enum constraints (research_brief's data_points.credibility)", () => {
	// Regression: deepseek-v4-flash hallucinated numbers (5, 7, 8) for credibility/surprise_factor
	// on a real run because the spec only listed the field NAME, not its allowed values.
	const spec = makeRealWaypointDeps({}).schemaSpec!("research_brief")!;
	expect(spec).toContain("credibility*=one of primary_source|secondary_source|anecdotal");
	expect(spec).toContain("surprise_factor=one of expected|notable|surprising|counterintuitive");
});

test("readSchemaSpec marks array-item required fields and nested array-typed sub-fields", () => {
	// Regression: deepseek-v4-flash repeatedly sent a string for angles_discovered[].grounded_in
	// (which must be an array) — the spec gave no signal that this sub-field is array-typed.
	const spec = makeRealWaypointDeps({}).schemaSpec!("research_brief")!;
	expect(spec).toContain("grounded_in=array of string");
	// name/hook/type/why_now are required within each angles_discovered item; grounded_in is not.
	expect(spec).toMatch(/name\*/);
	expect(spec).not.toMatch(/grounded_in\*/);
});

test("readSchemaSpec decorates a nested object's own array-typed sub-fields (landscape.existing_content)", () => {
	// Regression: deepseek-v4-flash sent existing_content/saturated_angles/underserved_gaps as
	// non-arrays because `landscape (object: existing_content, saturated_angles, ...)` only
	// listed bare field names, with no hint that those sub-fields are themselves arrays.
	const spec = makeRealWaypointDeps({}).schemaSpec!("research_brief")!;
	expect(spec).toMatch(/saturated_angles\*?=array of string/);
	// Deeper regression: existing_content is object → array → item (3 levels). The model
	// repeatedly omitted source/angle/what_it_covers identically across every retry because
	// the item's own required sub-fields were never surfaced — only the array's name was.
	expect(spec).toContain("existing_content*=array, minItems 3 of {title*, url, source*, angle*, what_it_covers*");
});

test("readSchemaSpec recurses through object -> array -> item (audience_insights.misconceptions.myth)", () => {
	// Same 3-level shape as existing_content but via the object branch first:
	// research_brief -> audience_insights (object) -> misconceptions (array) -> {myth*, reality*, source}.
	const spec = makeRealWaypointDeps({}).schemaSpec!("research_brief")!;
	expect(spec).toContain("misconceptions*=array of {myth*, reality*, source}");
});

test("readSchemaSpec surfaces a top-level const constraint (version must be exactly \"1.0\")", () => {
	// Regression: every artifact schema pins `version` via `const: "1.0"`, not `enum`.
	// A real run showed deepseek-v4-flash exhausting all retries on
	// `/version: must be equal to constant` because the spec only said "version (string)",
	// with zero hint that a specific literal value was required.
	const spec = makeRealWaypointDeps({}).schemaSpec!("research_brief")!;
	expect(spec).toContain('version (must be exactly "1.0")');
});
