/**
 * E2E orchestration test — the full DETERMINISTIC tool chain, real I/O.
 *
 * This is the "full test how these tools orchestrate" deliverable. Unlike
 * toolWiring.test.mjs (which mocks the entire pi-obsidian module to assert
 * argument wiring only) and unlike ingest/retrieve.test.ts (which call the
 * src/ library functions directly, bypassing the extension tool layer), THIS
 * test drives the chain through the real `execute()` functions of the three
 * deterministic tools:
 *
 *   zk_ingest (tool) -> src/ingest.ts -> real files on disk -> MOC + cross-links
 *   knowledge_query (tool) -> src/retrieve.ts -> reads those files back
 *   graphHealth (library) -> src/retrieve.ts -> audits the folder it just wrote
 *     (was graph_health tool; merged into obsidian_garden engine:deterministic in Phase 1)
 *
 * No LLM, no subagent, no mock of pi-obsidian's parser/index/validate — those
 * run for REAL against a temp vault. The ONLY redirection is vault resolution:
 * `OB_VAULT_PATH` (resolveVault Tier-1a) is pointed at a fresh temp dir so the
 * tools write/read there instead of the real pi-agent-vault.
 *
 * MOCK.GUARD (mock.module leak insulation):
 * Under `bun test` (no --isolate), test files share ONE process. When
 * toolWiring.test.mjs registers mock.module("@repo/.../obsidian.ts") at the
 * process level, that mock leaks into sibling test files' static imports.
 *
 * We prevent this by pre-loading the REAL obsidian module via absolute
 * filesystem path BEFORE registering our own mock.module (which uses a SYNC
 * factory to spread the real exports + override resolveVault). The sync factory
 * avoids Bun's import interception inside mock() factories, and the pre-load
 * step caches the real module under an un-interceptable filesystem path.
 *
 *   bun test __tests__/e2e-orchestration.test.ts
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
	readdirSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphHealth, healGraph, formatHealth } from "../src/retrieve.ts";

// ---------------------------------------------------------------------------
// mock.module guard — pre-load the REAL obsidian module by absolute path
// (bypasses the mock system entirely), then register our own mock with a
// sync factory that spreads the real exports + overrides only resolveVault.
//
// IMPORTANT: this runs at module evaluation time (top-level await), BEFORE
// the pi-knowledge-card extension or any dynamic import of obsidian symbols.
// This also overrides any leaked mock from toolWiring.test.mjs.
// ---------------------------------------------------------------------------

const _obsRealAbs = new URL(
	"../../pi-agent-ext-obsidian/src/index.ts",
	import.meta.url,
).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);

mock.module("@repo/pi-agent-ext-obsidian", () => ({
	..._obsReal,
	resolveVault: async (_cwd: string) => {
		const envPath = process.env.OB_VAULT_PATH;
		if (envPath) {
			return { path: envPath, name: "KCardE2E", registered: true, source: "env" };
		}
		return (_obsReal.resolveVault as (cwd: string) => Promise<unknown>)(_cwd);
	},
}));

// ---------------------------------------------------------------------------
// Vault harness — point resolveVault at a fresh temp vault via OB_VAULT_PATH
// (Tier-1a, wins over config).
// ---------------------------------------------------------------------------

let vault = "";
let savedVaultEnv: string | undefined;

// Extension + tools — registered once; import DYNAMICALLY so the mock guard
// is active before the extension module evaluates its own obsidian imports.
let _tools: Record<string, { execute: Function }> = {};
let _ctx = { cwd: process.cwd() };

function makeFakePi() {
	const tools: Record<string, { execute: Function }> = {};
	return {
		pi: {
			registerTool: (t: { name: string; execute: Function }) => {
				tools[t.name] = t;
			},
			registerCommand: () => {},
			on: () => {},
		},
		tools,
	};
}

async function ensureExtension() {
	if (Object.keys(_tools).length === 0) {
		const kc = await import("../extensions/knowledge-card.ts");
		const { pi, tools } = makeFakePi();
		(kc.default as (pi: unknown) => void)(pi as never);
		_tools = tools;
	}
}

async function run(toolName: string, params: Record<string, unknown>) {
	await ensureExtension();
	return _tools[toolName].execute("e2e-id", params, undefined, undefined, _ctx);
}

function cardSlugs(): string[] {
	const abs = join(vault, "Zettelkasten/knowledge-graph");
	if (!existsSync(abs)) return [];
	return readdirSync(abs)
		.filter((n) => n.endsWith(".md"))
		.map((n) => n.slice(0, -3))
		.sort();
}

beforeEach(async () => {
	vault = mkdtempSync(join(tmpdir(), "kcard-e2e-"));
	savedVaultEnv = process.env.OB_VAULT_PATH;
	process.env.OB_VAULT_PATH = vault;
	mkdirSync(join(vault, "Tags"), { recursive: true });
});

afterEach(async () => {
	if (savedVaultEnv === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = savedVaultEnv;
rmSync(vault, { recursive: true, force: true });
});

const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

// graph_health tool removed (Phase 1 de-dup); audit via library directly.
async function auditHealth() {
	return graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
}
async function fixHealth() {
	await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
	return graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
}

// ---- test records (synthetic cross-source fixture for orchestration) -------

function jsonl(records: Record<string, unknown>[]): string {
	return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const FLUX2_RECORDS = [
	{
		schema_version: 1,
		id: "flux2:cfg-scale-7-lever",
		type: "lever",
		title: "Flux2 Klein default cfg 7 balances detail and coherence",
		detail:
			"Flux2 Klein's default cfg=7 is the sweet spot. Lower (4-5) washes out detail; higher (9+) fries edges. Measured across 50 seeds.",
		tags: ["flux2", "lora", "cfg-scale"],
		dimension: "image-quality",
		confidence: 0.91,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 3, first_seen: "2026-06-01T00:00:00", last_seen: "2026-06-10T00:00:00" },
	},
	{
		schema_version: 1,
		id: "flux2:lora-scale-override-gotcha",
		type: "gotcha",
		title: "Flux2 LoRA scale override silently overwrites CLI flag",
		detail:
			"> [!warning] The --lora-scale flag is a no-op when the LoRA config sets scale explicitly.\nAlways check the LoRA's embedded config before relying on the CLI flag.",
		tags: ["flux2", "lora", "argparse", "cfg-scale"],
		dimension: "correctness",
		confidence: 0.88,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 2, first_seen: "2026-06-02T00:00:00", last_seen: "2026-06-08T00:00:00" },
	},
];

const LTX_RECORDS = [
	{
		schema_version: 1,
		id: "ltx:cfg-scale-7-lever",
		type: "lever",
		title: "LTX-2.3 video cfg 7 matches Flux2 image cfg sweet spot",
		detail:
			"LTX video cfg=7 mirrors the Flux2 image finding — lower cfg produces softer motion, higher cfg introduces temporal flicker.",
		tags: ["ltx", "cfg-scale", "video-quality"],
		dimension: "image-quality",
		confidence: 0.85,
		status: "active",
		superseded_by: null,
		evidence: { occurrences: 2, first_seen: "2026-06-05T00:00:00", last_seen: "2026-06-09T00:00:00" },
	},
	{
		schema_version: 1,
		id: "ltx:retired-stale-approach",
		type: "false_positive",
		title: "LTX 8-step is NOT the default anymore (retired)",
		detail: "Superseded by the mu=1.15 8-step native path. Kept only for A/B comparison.",
		tags: ["ltx", "steps"],
		dimension: "image-quality",
		confidence: 0.6,
		status: "retired",
		superseded_by: null,
		evidence: { occurrences: 1, first_seen: "2026-05-01T00:00:00", last_seen: "2026-05-01T00:00:00" },
	},
];

const FIXTURE_PATH = new URL("../fixtures/pi-ext-dev.knowledge.jsonl", import.meta.url)
	.pathname;

// ===========================================================================
// PHASE 1 — WRITE: zk_ingest end-to-end through the tool layer
// ===========================================================================

describe("E2E - zk_ingest (tool -> library -> real files)", () => {
	test("ingests records into a real vault folder + writes the MOC", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl(FLUX2_RECORDS));

		const res = await run("zk_ingest", {
			files: [file],
			source: "workflow-jsonl",
			source_label: "e2e:flux2",
		});

		expect(res.isError).toBeUndefined();
		expect(res.details.total).toBe(2);
		expect(res.details.created).toBe(2);
		expect(res.details.updated).toBe(0);
		expect(res.details.mocUpdated).toBe(true);

		const slugs = cardSlugs();
		expect(slugs.length).toBe(2);
		expect(slugs).toContain("flux2-cfg-scale-7-lever");
		expect(slugs).toContain("flux2-lora-scale-override-gotcha");

		const mocAbs = join(vault, MOC);
		expect(existsSync(mocAbs)).toBe(true);
		const moc = readFileSync(mocAbs, "utf8");
		expect(moc).toContain("flux2-cfg-scale-7-lever");
		expect(moc).toContain("flux2-lora-scale-override-gotcha");
	});

	test("each card is a valid zettel (id/created/tags[0]==zettel)", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl([FLUX2_RECORDS[0]]));
		await run("zk_ingest", { files: [file], source: "workflow-jsonl" });

		const card = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		const { validateZettelNote } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		expect(validateZettelNote(card).ok).toBe(true);
		expect(card).toContain('id: "flux2:cfg-scale-7-lever"');
		expect(card).toContain("zettel");
	});

	test("cross-source tag overlap forms a [[wiki-link]] edge (the convergence thesis)", async () => {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl([FLUX2_RECORDS[0]]));
		writeFileSync(l, jsonl([LTX_RECORDS[0]]));

		await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		await run("zk_ingest", { files: [l], source: "workflow-jsonl", source_label: "e2e:ltx" });

		// Cross-link edges are computed at INGEST time against cards already on
		// disk. The ltx record (ingested second) sees the flux2 card and writes a
		// [[wiki-link]] to it — a cross-source edge formed purely from shared tags.
		const ltxCard = readFileSync(join(vault, FOLDER, "ltx-cfg-scale-7-lever.md"), "utf8");
		expect(ltxCard).toContain("[[flux2-cfg-scale-7-lever]]");
	});

	test("idempotency: re-ingest is byte-identical (unchanged, never rewritten)", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl(FLUX2_RECORDS));
		await run("zk_ingest", { files: [file], source: "workflow-jsonl" });

		const before = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);

		const res2 = await run("zk_ingest", { files: [file], source: "workflow-jsonl" });
		expect(res2.details.created).toBe(0);
		expect(res2.details.unchanged).toBe(2);

		const after = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		expect(after).toBe(before);
	});

	test("dry_run reports what would happen without touching the vault", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl(FLUX2_RECORDS));
		const res = await run("zk_ingest", { files: [file], source: "workflow-jsonl", dry_run: true });

		expect(res.details.total).toBe(2);
		expect(res.details.created).toBe(2);
		expect(cardSlugs().length).toBe(0);
		expect(existsSync(join(vault, MOC))).toBe(false);
	});

	test("empty array -> isError; nonexistent path -> no_input_files code", async () => {
		const resEmpty = await run("zk_ingest", { files: [], source: "workflow-jsonl" });
		expect(resEmpty.isError).toBe(true);
		expect(resEmpty.details).toBeNull();

		const resMissing = await run("zk_ingest", {
			files: ["does-not-exist.knowledge.jsonl"],
			source: "workflow-jsonl",
		});
		expect(resMissing.isError).toBe(true);
		expect(resMissing.details.code).toBe("no_input_files");
		expect(resMissing.details.skipped.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================================================
// PHASE 2 — READ: knowledge_query retrieves what zk_ingest wrote
// ===========================================================================

describe("E2E - knowledge_query (tool -> library -> reads ingested cards)", () => {
	async function seedBoth() {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));
		await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		await run("zk_ingest", { files: [l], source: "workflow-jsonl", source_label: "e2e:ltx" });
		invalidateCache(vault);
	}

	test("tag query returns cross-source cards that share the tag", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["cfg-scale"] });
		expect(res.isError).toBeUndefined();
		expect(res.details.count).toBe(3);
		expect(
			res.details.cards.map((c: { id: string }) => c.id).sort(),
		).toEqual(["flux2:cfg-scale-7-lever", "flux2:lora-scale-override-gotcha", "ltx:cfg-scale-7-lever"]);
		expect(res.content[0].text).toContain("Flux2 Klein default cfg 7");
		expect(res.content[0].text).toContain("LTX-2.3 video cfg 7");
	});

	test("narrower tag returns only the matching subset", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["video-quality"] });
		expect(res.details.count).toBe(1);
		expect(res.details.cards[0].id).toBe("ltx:cfg-scale-7-lever");
	});

	test("callout card surfaces its [!warning] headline in the digest", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["argparse"] });
		expect(res.details.count).toBe(1);
		expect(res.content[0].text).toContain("[!warning]");
	});

	test("retired cards are excluded from query results", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["steps"] });
		expect(res.details.count).toBe(0);
	});

	test("natural-language query is tokenised into tags when tags[] omitted", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { query: "flux2 lora gotcha" });
		expect(res.details.count).toBeGreaterThanOrEqual(1);
		expect(
			res.details.cards.some((c: { id: string }) => c.id === "flux2:lora-scale-override-gotcha"),
		).toBe(true);
	});

	test("no match -> 0 count, not an error", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["nonexistent-xyz"] });
		expect(res.isError).toBeUndefined();
		expect(res.details.count).toBe(0);
	});

	test("no tags AND no query -> neutral hint, not an error", async () => {
		await seedBoth();
		const res = await run("knowledge_query", {});
		expect(res.isError).toBeUndefined();
		expect(res.content[0].text).toMatch(/tags\[\]|query/i);
	});
});

// ===========================================================================
// PHASE 3 — AUDIT: graph_health audits the folder the tools just wrote
// ===========================================================================

describe("E2E - graphHealth (library -> audits own output)", () => {
	async function seed() {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));
		await run("zk_ingest", { files: [f], source: "workflow-jsonl" });
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		await run("zk_ingest", { files: [l], source: "workflow-jsonl" });
		invalidateCache(vault);
	}

	test("a freshly-ingested graph is healthy (no dead links, MOC in sync)", async () => {
		await seed();
		const h = await auditHealth();
		expect(h.ok).toBe(true);
		expect(h.cardCount).toBe(4);
		expect(h.deadLinks.length).toBe(0);
		expect(h.mocMissing).toBe(false);
		expect(h.mocStale).toBe(false);
	});

	test("MOC drift is detected (delete the MOC -> mocMissing)", async () => {
		await seed();
		rmSync(join(vault, MOC));
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		const h = await auditHealth();
		expect(h.mocMissing).toBe(true);
		expect(h.ok).toBe(false);
	});

	test("fix:true heals MOC drift (regenerates the MOC)", async () => {
		await seed();
		rmSync(join(vault, MOC));
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);

		const h = await fixHealth();
		expect(h.ok).toBe(true);
		expect(existsSync(join(vault, MOC))).toBe(true);
	});

	test("report includes the human-readable formatHealth text", async () => {
		await seed();
		const h = await auditHealth();
		const text = formatHealth(h);
		expect(text).toMatch(/card/i);
		expect(text).toMatch(/dead|link|ok/i);
	});
});

// ===========================================================================
// FULL CHAIN — ingest -> query -> health in one flow (the orchestration proof)
// ===========================================================================

describe("E2E - full deterministic orchestration (write -> read -> audit)", () => {
	test("the three deterministic tools compose correctly in sequence", async () => {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));

		// 1. WRITE
		const ingestRes = await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		expect(ingestRes.details.created).toBe(2);
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		const ingestRes2 = await run("zk_ingest", { files: [l], source: "workflow-jsonl", source_label: "e2e:ltx" });
		expect(ingestRes2.details.created).toBe(2);
		invalidateCache(vault);

		// 2. READ
		const queryRes = await run("knowledge_query", { tags: ["cfg-scale"] });
		expect(queryRes.details.count).toBe(3);
		expect(queryRes.details.scanned).toBeGreaterThanOrEqual(3);

		// 3. AUDIT
		const healthRes = await auditHealth();
		expect(healthRes.ok).toBe(true);
		expect(healthRes.cardCount).toBe(4);

		// 4. RE-WRITE (idempotency)
		invalidateCache(vault);
		const reIngest = await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		expect(reIngest.details.created).toBe(0);
		expect(reIngest.details.updated + reIngest.details.unchanged).toBe(2);

		// 5. graph still healthy after re-ingest
		invalidateCache(vault);
		const healthRes2 = await auditHealth();
		expect(healthRes2.ok).toBe(true);
	});
});

// ===========================================================================
// FIXTURE GUARD — the REAL pi-ext-dev extraction, reproducible + test-guarded
// ===========================================================================
// This ingests the shipped fixtures/pi-ext-dev.knowledge.jsonl (the genuine
// pi-extension-development knowledge) into a temp vault and verifies the full
// write->read->audit chain. The fixture IS the canonical source of truth; the
// vault cards are reproducible from it.
// ===========================================================================

import { parseKnowledgeJsonl } from "../src/adapters.ts";
const FIXTURE_RECORD_COUNT = 11;

describe("E2E - real pi-ext-dev fixture (reproducible extraction guard)", () => {
	test("the fixture is well-formed: 11 records, zero parse errors", () => {
		const { records, parseErrors } = parseKnowledgeJsonl(
			readFileSync(FIXTURE_PATH, "utf8"),
		);
		expect(parseErrors).toEqual([]);
		expect(records.length).toBe(FIXTURE_RECORD_COUNT);
		for (const r of records) {
			expect(r.id).toMatch(/^pi-ext-dev:/);
			expect(r.title.length).toBeGreaterThan(10);
			expect(r.tags.length).toBeGreaterThan(0);
		}
	});

	test("ingest the fixture -> query it back -> audit (the production flow)", async () => {
		const ingestRes = await run("zk_ingest", {
			files: [FIXTURE_PATH],
			source: "workflow-jsonl",
			source_label: "pi-ext-dev:fixture",
		});
		expect(ingestRes.isError).toBeUndefined();
		expect(ingestRes.details.created).toBe(FIXTURE_RECORD_COUNT);
		expect(ingestRes.details.linked).toBeGreaterThan(0);

		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		const capped = await run("knowledge_query", { tags: ["pi-ext-dev"] });
		expect(capped.details.count).toBe(10); // topK silo cap at 10

		const queryRes = await run("knowledge_query", { tags: ["pi-ext-dev"], topK: 20 });
		expect(queryRes.details.count).toBe(FIXTURE_RECORD_COUNT);
		const ids = queryRes.details.cards.map((c: { id: string }) => c.id).sort();
		expect(ids.every((id: string) => id.startsWith("pi-ext-dev:"))).toBe(true);

		invalidateCache(vault);
		const healthRes = await auditHealth();
		expect(healthRes.ok).toBe(true);
		expect(healthRes.cardCount).toBe(FIXTURE_RECORD_COUNT);
	});

	test("the fixture ingest is idempotent (byte-stable re-run)", async () => {
		await run("zk_ingest", {
			files: [FIXTURE_PATH],
			source: "workflow-jsonl",
			source_label: "pi-ext-dev:fixture",
		});
		const aCard = join(
			vault,
			FOLDER,
			"pi-ext-dev-extension-is-default-factory-receiving-extensionapi.md",
		);
		const before = readFileSync(aCard, "utf8");
		const { invalidateCache } = await import(
			"@repo/pi-agent-ext-obsidian"
		);
		invalidateCache(vault);
		const re = await run("zk_ingest", {
			files: [FIXTURE_PATH],
			source: "workflow-jsonl",
			source_label: "pi-ext-dev:fixture",
		});
		expect(re.details.created).toBe(0);
		expect(re.details.unchanged).toBe(FIXTURE_RECORD_COUNT);
		expect(readFileSync(aCard, "utf8")).toBe(before);
	});
});
