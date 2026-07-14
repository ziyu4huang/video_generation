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
