/**
 * dispatch-validation.test.ts — TDD driver for the obsidian fat-tool's runtime
 * Value.Check validation. After the param schema collapses to {action, args},
 * schema-layer arg validation disappears; this test pins the runtime validation
 * that recovers it (bad args → clean error listing valid args + pointing to
 * obsidian_help).
 *
 * `_capture` lives inside the factory closure, so validateActionArgs takes an
 * injected schema resolver. The test builds the resolver from a capturing-mock
 * (same pattern `tools-metrics --schema-cost` + the ltx stealth-trim test use).
 */
import { test, expect, describe } from "bun:test";
import extensionFactory, { validateActionArgs } from "../obsidian.ts";

function capturePerActionSchemas(): Map<string, unknown> {
	const tools: Record<string, Record<string, unknown>> = {};
	const capture = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
	};
	// The obsidian factory also calls pi.registerCommand / pi.on / etc. — swallow
	// them all (same Proxy pattern `tools-metrics --schema-cost` uses).
	const mockPi = new Proxy(capture, {
		get: (target, prop) => {
			if (prop in target) return (target as Record<string | symbol, unknown>)[prop as string];
			return () => {};
		},
	});
	extensionFactory(mockPi as never);
	// Per-action tools (obsidian_list, obsidian_read, ...) are registered on the
	// factory's INTERNAL _capture, not on pi. The fat tool re-exposes them via
	// its `_capturedTools` field — read the per-action schemas from there.
	const captured = (tools["obsidian"]?._capturedTools ?? {}) as Record<string, Record<string, unknown>>;
	const schemas = new Map<string, unknown>();
	for (const [name, def] of Object.entries(captured)) {
		if (def?.parameters) schemas.set(name, def.parameters);
	}
	return schemas;
}

const schemas = capturePerActionSchemas();
const resolveSchema = (action: string): unknown | null =>
	schemas.get("obsidian_" + action) ?? null;

describe("obsidian dispatcher — runtime Value.Check validation", () => {
	test("rejects an unknown arg for a known action, lists valid args", () => {
		// obsidian_read accepts { note, offset, limit } — `notE` is a `note` typo.
		const res = validateActionArgs("read", { notE: "x.md" }, resolveSchema);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errorText).toContain("read");
			expect(res.errorText).toContain("note");
		}
	});

	test("accepts valid args for a known action", () => {
		const res = validateActionArgs("read", { note: "Inbox.md" }, resolveSchema);
		expect(res.ok).toBe(true);
	});

	test("rejects a typed mismatch (delete.confirm must be boolean)", () => {
		const res = validateActionArgs("delete", { note: "x.md", confirm: "yes" }, resolveSchema);
		expect(res.ok).toBe(false);
	});

	test("error text points to obsidian_help", () => {
		// `note` must be a string — 123 is a real type violation (not just an extra key).
		const res = validateActionArgs("read", { note: 123 }, resolveSchema);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errorText).toMatch(/obsidian_help/);
	});

	test("rejects an unknown action with the full valid list", () => {
		const res = validateActionArgs("detonate", {}, resolveSchema);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errorText).toContain("Unknown");
			expect(res.errorText).toContain("status");
		}
	});
});
