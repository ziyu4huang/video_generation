import { describe, expect, test } from "bun:test";
import { parseExtManifest } from "./ext-manifest.ts";

const HOST = { hostApi: 1, hostModules: ["typebox", "@earendil-works/pi-tui"] };

function valid(overrides: Record<string, unknown> = {}) {
	return {
		name: "power-tool",
		package: "@repo/pi-agent-ext-power-tool",
		version: "0.1.0",
		hostApi: 1,
		entry: "ext.cjs",
		order: 50,
		enabled: true,
		skills: ["skills"],
		hostModules: ["typebox"],
		builtAt: "2026-08-19T20:13:00Z",
		sourceSha: "520acb928",
		...overrides,
	};
}

describe("parseExtManifest", () => {
	test("accepts a valid manifest", () => {
		const r = parseExtManifest(valid(), "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.manifest.name).toBe("power-tool");
			expect(r.manifest.order).toBe(50);
			expect(r.manifest.skills).toEqual(["skills"]);
		}
	});

	test("defaults enabled/order/skills when absent", () => {
		const m = valid();
		delete (m as Record<string, unknown>).enabled;
		delete (m as Record<string, unknown>).order;
		delete (m as Record<string, unknown>).skills;
		const r = parseExtManifest(m, "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.manifest.enabled).toBe(true);
			expect(r.manifest.order).toBe(100);
			expect(r.manifest.skills).toEqual([]);
		}
	});

	test("rejects a name that disagrees with the directory", () => {
		const r = parseExtManifest(valid({ name: "other" }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/name "other" does not match directory "power-tool"/);
	});

	test("rejects a hostApi mismatch", () => {
		const r = parseExtManifest(valid({ hostApi: 2 }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/hostApi 2.*host provides 1/);
	});

	test("rejects a host module the host does not provide", () => {
		const r = parseExtManifest(valid({ hostModules: ["typebox", "left-pad"] }), "power-tool", HOST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/left-pad/);
	});

	test("rejects an entry that escapes the extension directory", () => {
		for (const entry of ["../evil.cjs", "/abs/evil.cjs", "nested/../../evil.cjs"]) {
			const r = parseExtManifest(valid({ entry }), "power-tool", HOST);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/entry/);
		}
	});

	test("rejects a skills path that escapes the extension directory", () => {
		const r = parseExtManifest(valid({ skills: ["../../etc"] }), "power-tool", HOST);
		expect(r.ok).toBe(false);
	});

	test("reports disabled as a non-error skip", () => {
		const r = parseExtManifest(valid({ enabled: false }), "power-tool", HOST);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.manifest.enabled).toBe(false);
	});

	test("rejects a non-object payload", () => {
		expect(parseExtManifest(null, "x", HOST).ok).toBe(false);
		expect(parseExtManifest("nope", "x", HOST).ok).toBe(false);
		expect(parseExtManifest([], "x", HOST).ok).toBe(false);
	});

	test("rejects missing required fields", () => {
		for (const field of ["name", "version", "hostApi", "entry"]) {
			const m = valid();
			delete (m as Record<string, unknown>)[field];
			const r = parseExtManifest(m, "power-tool", HOST);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(new RegExp(field));
		}
	});
});
