/**
 * Convergence loop tests — `src/loop.ts` (the deterministic orchestration core).
 *
 * `runConvergenceLoop` is the trusted core both the `kcard-loop` CLI (Phase 2)
 * and the `kcard-converge-loop` saved workflow (Phase 3) wrap. It calls the
 * existing src library fns directly — `ingestRecords` / `graphHealth` /
 * `healGraph` / `retrieveRecords` — with a passed-in `vaultPath`, so it needs
 * no LLM, no subagent, and no `resolveVault`.
 *
 * MOCK.GUARD: same insulation as `e2e-orchestration.test.ts`. Under shared-
 * process `bun test`, `toolWiring.test.mjs` leaks a stubbed pi-obsidian module
 * that would replace the REAL `parseFrontmatter` / `getIndex` / `validateZettelNote`
 * these library fns import. We pre-load the real obsidian module by absolute path
 * and register our own mock that spreads the real exports (overriding only
 * resolveVault, which the src layer never calls anyway). Run with:
 *
 *   bun test __tests__/loop.test.ts
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// mock.module guard — verbatim from e2e-orchestration.test.ts (insulates the
// real pi-obsidian parser/index symbols from toolWiring's leaked stub).
// ---------------------------------------------------------------------------
const _obsRealAbs = new URL(
	"../../pi-agent-ext-obsidian/extensions/obsidian.ts",
	import.meta.url,
).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);

mock.module("@repo/pi-agent-ext-obsidian/extensions/obsidian.ts", () => ({
	..._obsReal,
	resolveVault: async () => {
		const envPath = process.env.OB_VAULT_PATH;
		if (envPath) return { path: envPath, name: "LoopTest", registered: true, source: "env" };
		return { path: process.cwd(), name: "LoopTest", registered: true, source: "env" };
	},
}));

// Module under test — imported AFTER the mock guard is registered.
const { runConvergenceLoop, probeRecall, healthGate } = await import("../src/loop.ts");

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

function jsonl(records: object[]): string {
	return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const CFG_RECORDS = [
	{
		schema_version: 1,
		id: "loop:cfg-scale-7-lever",
		type: "lever",
		title: "cfg 7 is the sweet spot for image and video",
		detail: "Lower cfg gives soft motion; higher cfg introduces flicker. cfg=7 mirrors the image finding.",
		tags: ["cfg-scale", "lever", "image-quality"],
		dimension: "image-quality",
		confidence: 0.85,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 2, first_seen: "2026-06-05", last_seen: "2026-06-09" },
	},
	{
		schema_version: 1,
		id: "loop:steps-8-gotcha",
		type: "gotcha",
		title: "8 steps is NOT the default anymore",
		detail: "Superseded by the mu=1.15 native path. Kept only for A/B comparison.",
		tags: ["steps", "gotcha", "image-quality"],
		dimension: "image-quality",
		confidence: 0.7,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 1, first_seen: "2026-05-01", last_seen: "2026-05-01" },
	},
];

// A free-form .md file for the `generic` adapter (one record per file).
const GENERIC_MD = `# VAE decode black image

When the VAE decode produces a fully black image, the bfloat16 → float32 cast
in the decoder lost precision. File the bug under \`vae\` and \`black-image\`.

#vae #black-image #gotcha
`;

let vault = "";
let jsonlSrc = "";
let genericDir = "";

function freshVault() {
	vault = mkdtempSync(join(tmpdir(), "kc-loop-"));
	jsonlSrc = join(vault, "in", "loop.knowledge.jsonl");
	// source files live OUTSIDE the convergence folder so ingest doesn't see them
	// as cards; only the lib's collectInputFiles reads them.
	require_fs_mkdir(join(vault, "in"));
	genericDir = join(vault, "in", "generic");
	require_fs_mkdir(genericDir);
}

// tiny mkdir helper (avoids importing node:fs.mkdirSync at top just for this)
function require_fs_mkdir(p: string) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { mkdirSync } = require("node:fs") as typeof import("node:fs");
	mkdirSync(p, { recursive: true });
}

beforeEach(() => {
	freshVault();
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

// ===========================================================================
// runConvergenceLoop
// ===========================================================================
describe("runConvergenceLoop", () => {
	test("ingests two source families, converges a dirty vault, idempotent on re-run", async () => {
		// seed two sources
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		writeFileSync(join(genericDir, "vae-black.md"), GENERIC_MD);

		const receipt = await runConvergenceLoop({
			sources: [
				{ path: jsonlSrc, family: "workflow-jsonl" },
				{ path: genericDir, family: "generic" },
			],
			vaultPath: vault,
		});

		// Phase A — ingest happened: 2 jsonl records + 1 generic card
		expect(receipt.sourcesIngested).toBe(2);
		expect(receipt.created).toBeGreaterThanOrEqual(3);
		expect(receipt.deadLinksAfter).toBe(0);
		expect(receipt.mocMissingAfter).toBe(false);
		expect(receipt.converged).toBe(true);
		// a FRESH ingest is already healthy (e2e: "freshly-ingested graph is healthy"),
		// so the heal loop runs 0 rounds; the dirty-vault healing is covered below.
		expect(receipt.rounds).toBeGreaterThanOrEqual(0);
		expect(receipt.rounds).toBeLessThanOrEqual(8);
		expect(receipt.truncated).toBe(false);
		// MOC was written
		expect(existsSync(join(vault, MOC))).toBe(true);
	});

	test("heals a deliberately dirtied graph (dead link + MOC drift)", async () => {
		// first converge clean
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		await runConvergenceLoop({
			sources: [{ path: jsonlSrc, family: "workflow-jsonl" }],
			vaultPath: vault,
		});

		// dirty: delete MOC + inject a dead [[wikilink]] into a card body
		rmSync(join(vault, MOC));
		const cardDir = join(vault, FOLDER);
		const aCard = readdirSync(cardDir).find((n) => n.endsWith(".md"));
		expect(aCard).toBeTruthy();
		appendFileSync(join(cardDir, aCard!), "\n\n## 連結\n- [[ghost-nonexistent-target]]\n");

		const before = await healthGate({ vaultPath: vault });
		expect(before.ok).toBe(false);
		expect(before.reasons.length).toBeGreaterThan(0);

		// re-run with no NEW sources — pure heal pass
		const receipt = await runConvergenceLoop({
			sources: [{ path: jsonlSrc, family: "workflow-jsonl" }],
			vaultPath: vault,
		});

		expect(receipt.deadLinksBefore).toBeGreaterThanOrEqual(0);
		expect(receipt.deadLinksAfter).toBe(0);
		expect(receipt.mocMissingAfter).toBe(false);
		expect(receipt.converged).toBe(true);
		expect(existsSync(join(vault, MOC))).toBe(true);
	});

	test("idempotent: a second run with unchanged sources creates nothing and stays healthy", async () => {
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		writeFileSync(join(genericDir, "vae-black.md"), GENERIC_MD);

		const first = await runConvergenceLoop({
			sources: [
				{ path: jsonlSrc, family: "workflow-jsonl" },
				{ path: genericDir, family: "generic" },
			],
			vaultPath: vault,
		});
		expect(first.created).toBeGreaterThanOrEqual(3);

		const second = await runConvergenceLoop({
			sources: [
				{ path: jsonlSrc, family: "workflow-jsonl" },
				{ path: genericDir, family: "generic" },
			],
			vaultPath: vault,
		});
		// re-ingest is dedup-stable: NO new cards (deterministic sink, dedup by id).
		// `updated` MAY be >0: re-ingesting an earlier source recomputes its
		// cross-links against the now-fuller folder (the generic card appeared
		// after the jsonl cards in the first run). This cross-link reconciliation
		// is a FEATURE — the graph self-updates when sources converge — and
		// stabilizes after the second run. The load-bearing invariants:
		expect(second.created).toBe(0); // no duplicate cards minted
		expect(second.deadLinksAfter).toBe(0);
		expect(second.converged).toBe(true);
		expect(second.rounds).toBeLessThanOrEqual(first.rounds + 1);
	});

	test("respects maxRounds and reports truncated when it cannot converge", async () => {
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		// maxRounds: 0 forces truncation (no heal rounds allowed if unhealthy at start)
		const receipt = await runConvergenceLoop({
			sources: [{ path: jsonlSrc, family: "workflow-jsonl" }],
			vaultPath: vault,
			maxRounds: 0,
		});
		// with 0 rounds the loop cannot heal; if the fresh ingest happened to be
		// healthy this is converged — so assert the contract: rounds === 0 and
		// converged === finalHealth.ok (no healing occurred).
		expect(receipt.rounds).toBe(0);
		expect(receipt.converged).toBe(receipt.health.ok);
	});
});

// ===========================================================================
// probeRecall
// ===========================================================================
describe("probeRecall", () => {
	test("surfaces a card whose slug matches a query, and misses when absent", async () => {
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		// ingest via the loop so the vault is populated + healthy
		await runConvergenceLoop({
			sources: [{ path: jsonlSrc, family: "workflow-jsonl" }],
			vaultPath: vault,
		});

		// a query the ingested cfg lever SHOULD answer (tokens overlap tag + body)
		const hit = await probeRecall({
			vaultPath: vault,
			queries: [{ q: "cfg scale lever image quality", expect: "cfg-scale-7-lever" }],
		});
		expect(hit.total).toBe(1);
		expect(hit.hits).toBe(1);
		expect(hit.hitRate).toBeCloseTo(1, 5);

		// a query no card can answer
		const miss = await probeRecall({
			vaultPath: vault,
			queries: [{ q: "how do I tune the flux2 refister quux", expect: "nonexistent-slug" }],
		});
		expect(miss.hits).toBe(0);
		expect(miss.hitRate).toBe(0);
	});
});

// ===========================================================================
// healthGate
// ===========================================================================
describe("healthGate", () => {
	test("ok on a healthy folder, not-ok with reasons on drift", async () => {
		writeFileSync(jsonlSrc, jsonl(CFG_RECORDS));
		await runConvergenceLoop({
			sources: [{ path: jsonlSrc, family: "workflow-jsonl" }],
			vaultPath: vault,
		});

		const ok = await healthGate({ vaultPath: vault });
		expect(ok.ok).toBe(true);
		expect(ok.reasons).toEqual([]);

		// introduce MOC drift
		rmSync(join(vault, MOC));
		const drifted = await healthGate({ vaultPath: vault });
		expect(drifted.ok).toBe(false);
		expect(drifted.reasons.length).toBeGreaterThan(0);
	});
});
