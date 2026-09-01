/**
 * parity-probe — unit tests for the fingerprint probe source + parser.
 * Spawn-free: the probe source is exercised as a string (zero-import lint,
 * marker emission shape) and the parser against synthetic stderr payloads —
 * plus ONE end-to-end execution of the actual source (Bun.hash returns
 * BigInt; JSON.stringify throws on it — regression for the incident where
 * the probe crashed inside before_agent_start and never emitted a marker).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { PARITY_PROBE_SOURCE, parseParityFpLine, type ParityFingerprint } from "../src/parity-probe.js";

const GOOD_FP: ParityFingerprint = {
	mode: "dev-head",
	sessionStartFired: true,
	toolCount: 1,
	tools: [{ n: "read", s: "builtin", p: "<builtin:read>", dh: "123", sh: "456" }],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/x/s2-agent-ext-devops/skills/devops-workflow/SKILL.md", ch: "789" }],
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
	test("executes the probe source end-to-end — JSON.stringify survives (Bun.hash returns BigInt)", async () => {
		// The unit fixtures above parse SYNTHETIC fingerprints; this test runs
		// the real probe body. Before the BigInt fix, JSON.stringify(fp) threw
		// inside before_agent_start → extension error → marker never emitted.
		const dir = mkdtempSync(join(tmpdir(), "parity-probe-exec-"));
		const probePath = join(dir, "parity-probe.ts");
		writeFileSync(probePath, PARITY_PROBE_SOURCE);
		const handlers: Record<string, (...a: any[]) => any> = {};
		const chunks: string[] = [];
		const realWrite = process.stderr.write;
		const realExit = process.exit;
		const EXIT_SENTINEL = Symbol("parity-probe-exit");
		process.stderr.write = ((c: any) => {
			chunks.push(String(c));
			return true;
		}) as typeof process.stderr.write;
		process.exit = (() => {
			throw EXIT_SENTINEL;
		}) as typeof process.exit;
		try {
			const probe = (await import(pathToFileURL(probePath).href)).default as (pi: any) => void;
			probe({
				on: (ev: string, fn: (...a: any[]) => any) => {
					handlers[ev] = fn;
				},
				getAllTools: () => [
					{
						name: "t",
						description: "d",
						parameters: { b: 2, a: 1 },
						sourceInfo: { source: "builtin", path: "<builtin:t>" },
					},
				],
			});
			handlers.session_start?.();
			try {
				await handlers.before_agent_start({ systemPromptOptions: { skills: [] } });
			} catch (e) {
				if (e !== EXIT_SENTINEL) throw e; // the probe's process.exit(0)
			}
		} finally {
			process.stderr.write = realWrite;
			process.exit = realExit;
			rmSync(dir, { recursive: true, force: true });
		}
		const emitted = chunks.join("");
		const i = emitted.indexOf("[PARITY-FP-START]");
		expect(i).toBeGreaterThanOrEqual(0);
		const j = emitted.indexOf("[PARITY-FP-END]", i);
		expect(j).toBeGreaterThanOrEqual(0);
		const fp = JSON.parse(emitted.slice(i + "[PARITY-FP-START]".length, j));
		expect(fp.toolCount).toBe(1); // session_start actually hashed the fake tool
		expect(typeof fp.tools[0].dh).toBe("string");
		expect(typeof fp.tools[0].sh).toBe("string");
		expect(Number.isFinite(Number(fp.tools[0].dh))).toBe(true);
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
