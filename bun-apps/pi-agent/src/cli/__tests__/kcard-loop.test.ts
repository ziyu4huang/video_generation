/**
 * kcard-loop command tests — arg parsing + the command's receipt builder.
 *
 * The command's `run()` is a thin console-log shell over `runConvergenceFromArgs`
 * (which RETURNS the receipt), so these tests assert the pure builder directly —
 * no stdout capture, no process.argv. The convergence core itself is covered by
 * pi-knowledge-card's loop.test.ts; here we cover the CLI arg → option mapping
 * + the receipt shape.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiArgs } from "../args.ts";
import { kcardLoopCommand, runConvergenceFromArgs, slimReceiptForJson } from "../commands/kcard-loop.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
function jsonl(records: object[]): string {
	return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
const RECORDS = [
	{
		schema_version: 1,
		id: "cli:cfg-scale-7-lever",
		type: "lever",
		title: "cfg 7 is the sweet spot",
		detail: "Lower cfg gives soft motion; higher introduces flicker.",
		tags: ["cfg-scale", "lever", "image-quality"],
		dimension: "image-quality",
		confidence: 0.85,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 1, first_seen: "2026-06-05", last_seen: "2026-06-05" },
	},
	{
		schema_version: 1,
		id: "cli:steps-gotcha",
		type: "gotcha",
		title: "8 steps is not the default",
		detail: "Superseded by the mu=1.15 native path.",
		tags: ["steps", "gotcha"],
		dimension: null,
		confidence: 0.7,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 1, first_seen: "2026-06-05", last_seen: "2026-06-05" },
	},
];

let vault = "";
let src = "";
beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-cli-"));
	src = join(vault, "in", "src.knowledge.jsonl");
	// source lives outside the convergence folder
	const { mkdirSync } = require("node:fs") as typeof import("node:fs");
	mkdirSync(join(vault, "in"), { recursive: true });
	writeFileSync(src, jsonl(RECORDS));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

// ── flag parsing ────────────────────────────────────────────────────────────
describe("kcard-loop — flag parsing", () => {
	test("numeric flags: --max-rounds / --consecutive-empty / --max-links", () => {
		const out = parsePiArgs([
			"kcard-loop", "a.knowledge.jsonl",
			"--max-rounds", "5", "--consecutive-empty", "3", "--max-links", "20",
		]);
		expect(out.maxRounds).toBe(5);
		expect(out.consecutiveEmpty).toBe(3);
		expect(out.maxLinks).toBe(20);
	});
	test("value flags: --link-weighting / --probe-eval / --source", () => {
		const out = parsePiArgs([
			"kcard-loop", "a.knowledge.jsonl",
			"--link-weighting", "idf", "--probe-eval", "eval.json", "--source", "hermes",
		]);
		expect(out.linkWeighting).toBe("idf");
		expect(out.probeEval).toBe("eval.json");
		expect(out.source).toBe("hermes");
	});
	test("bool flags: --wiki-aware / --heal-only / --no-probe", () => {
		const out = parsePiArgs([
			"kcard-loop", "a.knowledge.jsonl", "--wiki-aware", "--heal-only", "--no-probe", "--json",
		]);
		expect(out.wikiAware).toBe(true);
		expect(out.healOnly).toBe(true);
		expect(out.noProbe).toBe(true);
		expect(out.json).toBe(true);
	});
	test("bad numeric throws fail-fast (--max-rounds abc)", () => {
		expect(() => parsePiArgs(["kcard-loop", "a.knowledge.jsonl", "--max-rounds", "abc"])).toThrow(
			/--max-rounds/,
		);
	});
	test("negative --consecutive-empty throws", () => {
		expect(() =>
			parsePiArgs(["kcard-loop", "a.knowledge.jsonl", "--consecutive-empty", "-1"]),
		).toThrow(/--consecutive-empty/);
	});
});

describe("kcard-loop — slimReceiptForJson (--json payload leanness)", () => {
	test("replaces health.deadLinks/orphans ARRAYS with COUNTS (no bloat for machine consumers)", () => {
		const receipt = {
			converged: true, truncated: false, sourcesIngested: 2,
			created: 3, updated: 1, unchanged: 0,
			deadLinksBefore: 2, deadLinksAfter: 0,
			mocMissingBefore: true, mocMissingAfter: false,
			rounds: 1, probeHits: 5, probeTotal: 10, probeHitRate: 0.5,
			health: {
				ok: true, vaultPath: "/v", folder: "f", mocPath: "m", cardCount: 539,
				deadLinks: [{ source: "a.md", target: "ghost" }, { source: "b.md", target: "ghost2" }],
				mocMissing: false, mocStale: false,
				orphans: ["o1", "o2", "o3"],
			},
		} as any
		const slim = slimReceiptForJson(receipt)
		// scalars preserved
		expect(slim.converged).toBe(true)
		expect(slim.created).toBe(3)
		expect(slim.probeHitRate).toBe(0.5)
		// arrays → counts
		expect((slim.health as any).deadLinks).toBe(2)
		expect((slim.health as any).orphans).toBe(3)
		expect((slim.health as any).ok).toBe(true)
		expect((slim.health as any).cardCount).toBe(539)
		// no array survives in health
		expect(Array.isArray((slim.health as any).deadLinks)).toBe(false)
		expect(Array.isArray((slim.health as any).orphans)).toBe(false)
		// total payload stays small (< 400 bytes for this case)
		expect(JSON.stringify(slim).length).toBeLessThan(400)
	})
})

// ── receipt builder ─────────────────────────────────────────────────────────
describe("kcard-loop — runConvergenceFromArgs", () => {
	test("ingests a source, converges, returns a receipt", async () => {
		const parsed = parsePiArgs(["kcard-loop", src, "--vault", vault, "--json"]);
		const receipt = await runConvergenceFromArgs(parsed, vault);
		expect(receipt.converged).toBe(true);
		expect(receipt.created).toBeGreaterThanOrEqual(2);
		expect(receipt.deadLinksAfter).toBe(0);
		expect(receipt.sourcesIngested).toBe(1);
		expect(receipt.rounds).toBeLessThanOrEqual(8);
	});
	test("supports family:path positional syntax for mixed sources", async () => {
		// a generic md source alongside the jsonl
		const { mkdirSync } = require("node:fs") as typeof import("node:fs");
		const genericDir = join(vault, "in", "generic");
		mkdirSync(genericDir, { recursive: true });
		writeFileSync(
			join(genericDir, "note.md"),
			"# VAE black image\n\nDecode casts bf16→f32 losing precision.\n\n#vae #black-image #gotcha\n",
		);
		const parsed = parsePiArgs([
			"kcard-loop",
			`workflow-jsonl:${src}`,
			`generic:${genericDir}`,
			"--vault", vault,
		]);
		const receipt = await runConvergenceFromArgs(parsed, vault);
		expect(receipt.sourcesIngested).toBe(2);
		expect(receipt.created).toBeGreaterThanOrEqual(3);
		expect(receipt.converged).toBe(true);
	});
	test("command object is well-formed + registered shape", () => {
		expect(kcardLoopCommand.name).toBe("kcard-loop");
		expect(typeof kcardLoopCommand.summary).toBe("string");
		expect(typeof kcardLoopCommand.details).toBe("string");
		expect(typeof kcardLoopCommand.run).toBe("function");
	});
});
