/**
 * parity-probe — unit tests for the fingerprint probe source + parser.
 * Spawn-free: the probe source is exercised as a string (zero-import lint,
 * marker emission shape) and the parser against synthetic stderr payloads.
 */
import { describe, expect, test } from "bun:test";
import { PARITY_PROBE_SOURCE, parseParityFpLine, type ParityFingerprint } from "../src/parity-probe.js";

const GOOD_FP: ParityFingerprint = {
	mode: "dev-head",
	sessionStartFired: true,
	toolCount: 1,
	tools: [{ n: "read", s: "builtin", p: "<builtin:read>", dh: 123, sh: 456 }],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/x/s2-agent-ext-devops/skills/devops-workflow/SKILL.md", ch: 789 }],
};

describe("PARITY_PROBE_SOURCE (zero-import contract)", () => {
	test("contains no import statements", () => {
		expect(/^\s*import\s/m.test(PARITY_PROBE_SOURCE)).toBe(false);
		expect(/^\s*export\s+.*from\s/m.test(PARITY_PROBE_SOURCE)).toBe(false);
	});
	test("emits the marker pair and exits 0 before any provider call", () => {
		expect(PARITY_PROBE_SOURCE).toContain("[PARITY-FP-START]");
		expect(PARITY_PROBE_SOURCE).toContain("[PARITY-FP-END]");
		expect(PARITY_PROBE_SOURCE).toContain("process.exit(0)");
	});
	test("hashes schemas through a key-sorting stable stringify", () => {
		// stableStringify must be defined inside the probe source (zero-import):
		// assert the canonicalization call site, not the runtime value.
		expect(PARITY_PROBE_SOURCE).toContain("stable(");
		expect(PARITY_PROBE_SOURCE).toMatch(/Object\.keys\(v\)\.sort\(\)/);
	});
});

describe("parseParityFpLine", () => {
	test("extracts the fingerprint from noisy stderr", () => {
		const noisy = `[hermes-memory] slow startup\n[PARITY-FP-START]${JSON.stringify({ ...GOOD_FP, marker: "PARITY_FP_v1" })}[PARITY-FP-END]\nother noise`;
		const r = parseParityFpLine(noisy);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.fp.tools[0]?.n).toBe("read");
			expect(r.fp.skillCount).toBe(1);
		}
	});
	test("no marker → ok:false", () => {
		const r = parseParityFpLine("just noise, maybe a provider auth error line");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("PARITY-FP-START");
	});
	test("wrong marker version → ok:false", () => {
		const r = parseParityFpLine(`[PARITY-FP-START]${JSON.stringify({ ...GOOD_FP, marker: "PARITY_FP_v0" })}[PARITY-FP-END]`);
		expect(r.ok).toBe(false);
	});
});
