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
 *   zk_ingest (tool) ─► src/ingest.ts ─► real files on disk ─► MOC + cross-links
 *   knowledge_query (tool) ─► src/retrieve.ts ─► reads those files back
 *   graph_health (tool) ─► src/retrieve.ts ─► audits the folder it just wrote
 *
 * No LLM, no subagent, no mock of pi-obsidian's parser/index/validate — those
 * run for REAL against a temp vault. The ONLY redirection is vault resolution:
 * `OB_VAULT_PATH` (resolveVault Tier-1a) is pointed at a fresh temp dir so the
 * tools write/read there instead of the real pi-agent-vault. bun:test isolates
 * each test FILE in its own process, so this env override cannot leak into the
 * sibling test files.
 *
 *   bun test __tests__/e2e-orchestration.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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
import { invalidateCache } from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import kc from "../extensions/pi-knowledge-card.ts";

// ---------------------------------------------------------------------------
// Vault harness — point resolveVault at a fresh temp vault via OB_VAULT_PATH
// (Tier-1a, wins over config). The deterministic library functions take
// vaultPath as a param directly, so they are NOT mocked; only resolution is.
// ---------------------------------------------------------------------------

let vault = "";
let savedVaultEnv: string | undefined;

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

const { pi, tools } = makeFakePi();
kc(pi as never);

const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";
const ctx = { cwd: process.cwd() };

// helper: run a registered tool's execute
async function run(toolName: string, params: Record<string, unknown>) {
	return tools[toolName].execute("e2e-id", params, undefined, undefined, ctx);
}

// helper: read every card slug present in the convergence folder
function cardSlugs(): string[] {
	const abs = join(vault, FOLDER);
	if (!existsSync(abs)) return [];
	return readdirSync(abs)
		.filter((n) => n.endsWith(".md"))
		.map((n) => n.slice(0, -3))
		.sort();
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-e2e-"));
	savedVaultEnv = process.env.OB_VAULT_PATH;
	process.env.OB_VAULT_PATH = vault;
	// seed the Tags/ dir so the MOC can land
	mkdirSync(join(vault, "Tags"), { recursive: true });
});

afterEach(() => {
	if (savedVaultEnv === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = savedVaultEnv;
	invalidateCache(vault);
	rmSync(vault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Records — cross-source, overlapping tags so cross-link EDGES form.
// "flux2" + "lora" overlap is the classic convergence scenario.
// ---------------------------------------------------------------------------

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

// ===========================================================================
// PHASE 1 — WRITE: zk_ingest end-to-end through the tool layer
// ===========================================================================

describe("E2E — zk_ingest (tool → library → real files)", () => {
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

		// cards on disk
		const slugs = cardSlugs();
		expect(slugs.length).toBe(2);
		expect(slugs).toContain("flux2-cfg-scale-7-lever");
		expect(slugs).toContain("flux2-lora-scale-override-gotcha");

		// MOC exists + mentions both cards
		const mocAbs = join(vault, MOC);
		expect(existsSync(mocAbs)).toBe(true);
		const moc = readFileSync(mocAbs, "utf8");
		expect(moc).toContain("flux2-cfg-scale-7-lever");
		expect(moc).toContain("flux2-lora-scale-override-gotcha");
	});

	test("each card is a valid zettel (id/created/tags[0]==zettel) via validateZettelNote", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl([FLUX2_RECORDS[0]]));
		await run("zk_ingest", { files: [file], source: "workflow-jsonl" });

		const card = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		// validateZettelNote is the same guard the library uses internally — it
		// requires id/created and tags[0]=="zettel". If it passes, the card is a
		// valid zettel regardless of how YAML quotes the id or lays out the array.
		const { validateZettelNote } = await import("@repo/pi-agent-ext-obsidian/extensions/obsidian.ts");
		expect(validateZettelNote(card).ok).toBe(true);
		expect(card).toContain('id: "flux2:cfg-scale-7-lever"');
		expect(card).toContain("zettel");
	});

	test("cross-source tag overlap forms a [[wiki-link]] edge (the convergence thesis)", async () => {
		// ingest flux2 (tags: flux2, lora, cfg-scale) then ltx (tags: ltx, cfg-scale)
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl([FLUX2_RECORDS[0]])); // flux2 + lora + cfg-scale
		writeFileSync(l, jsonl([LTX_RECORDS[0]])); // ltx + cfg-scale

		await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		// invalidate so the second ingest sees the first card's tags for linking
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

		// snapshot bytes
		const before = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		invalidateCache(vault);

		// re-ingest the SAME records
		const res2 = await run("zk_ingest", { files: [file], source: "workflow-jsonl" });
		expect(res2.details.created).toBe(0);
		expect(res2.details.unchanged).toBe(2);

		const after = readFileSync(join(vault, FOLDER, "flux2-cfg-scale-7-lever.md"), "utf8");
		expect(after).toBe(before); // byte-stable
	});

	test("dry_run reports what would happen without touching the vault", async () => {
		const file = join(vault, "flux2.knowledge.jsonl");
		writeFileSync(file, jsonl(FLUX2_RECORDS));
		const res = await run("zk_ingest", { files: [file], source: "workflow-jsonl", dry_run: true });

		expect(res.details.total).toBe(2);
		expect(res.details.created).toBe(2);
		// nothing written
		expect(cardSlugs().length).toBe(0);
		expect(existsSync(join(vault, MOC))).toBe(false);
	});

	test("empty array → isError; nonexistent path → no_input_files code", async () => {
		// empty array hits the first guard (inputs.length === 0)
		const resEmpty = await run("zk_ingest", { files: [], source: "workflow-jsonl" });
		expect(resEmpty.isError).toBe(true);
		expect(resEmpty.details).toBeNull();

		// a path that resolves to nothing hits the second guard (collectInputFiles
		// returns empty) → the structured no_input_files code + skipped report
		const resMissing = await run("zk_ingest", { files: ["does-not-exist.knowledge.jsonl"], source: "workflow-jsonl" });
		expect(resMissing.isError).toBe(true);
		expect(resMissing.details.code).toBe("no_input_files");
		expect(resMissing.details.skipped.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================================================
// PHASE 2 — READ: knowledge_query retrieves what zk_ingest wrote
// ===========================================================================

describe("E2E — knowledge_query (tool → library → reads ingested cards)", () => {
	async function seedBoth() {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));
		await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		invalidateCache(vault);
		await run("zk_ingest", { files: [l], source: "workflow-jsonl", source_label: "e2e:ltx" });
		invalidateCache(vault);
	}

	test("tag query returns cross-source cards that share the tag", async () => {
		await seedBoth();
		// "cfg-scale" is shared by BOTH flux2 records + the ltx lever → 3 cards
		// across two sources (the convergence thesis: cross-source edges surface
		// here for free).
		const res = await run("knowledge_query", { tags: ["cfg-scale"] });
		expect(res.isError).toBeUndefined();
		expect(res.details.count).toBe(3);
		expect(res.details.cards.map((c: { id: string }) => c.id).sort()).toEqual([
			"flux2:cfg-scale-7-lever",
			"flux2:lora-scale-override-gotcha",
			"ltx:cfg-scale-7-lever",
		]);
		// digest text names cards from both sources
		expect(res.content[0].text).toContain("Flux2 Klein default cfg 7");
		expect(res.content[0].text).toContain("LTX-2.3 video cfg 7");
	});

	test("narrower tag returns only the matching subset", async () => {
		await seedBoth();
		// "video-quality" is unique to the ltx lever (1 card)
		const res = await run("knowledge_query", { tags: ["video-quality"] });
		expect(res.details.count).toBe(1);
		expect(res.details.cards[0].id).toBe("ltx:cfg-scale-7-lever");
	});

	test("callout card surfaces its [!warning] headline in the digest", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["argparse"] });
		expect(res.details.count).toBe(1);
		const digest = res.content[0].text;
		// the warning callout text is lifted into the digest (P1 feature surfacing)
		expect(digest).toContain("[!warning]");
	});

	test("retired cards are excluded from query results", async () => {
		await seedBoth();
		// the retired "8-step" card carries tag "steps" + "ltx"
		const res = await run("knowledge_query", { tags: ["steps"] });
		expect(res.details.count).toBe(0); // retired → excluded
	});

	test("natural-language query is tokenised into tags when tags[] omitted", async () => {
		await seedBoth();
		// "flux2 lora" → tokens ["flux2","lora"] → matches the lora gotcha
		const res = await run("knowledge_query", { query: "flux2 lora gotcha" });
		expect(res.details.count).toBeGreaterThanOrEqual(1);
		expect(res.details.cards.some((c: { id: string }) => c.id === "flux2:lora-scale-override-gotcha")).toBe(true);
	});

	test("no match → 0 count, not an error", async () => {
		await seedBoth();
		const res = await run("knowledge_query", { tags: ["nonexistent-xyz"] });
		expect(res.isError).toBeUndefined();
		expect(res.details.count).toBe(0);
	});

	test("no tags AND no query → neutral hint, not an error", async () => {
		await seedBoth();
		const res = await run("knowledge_query", {});
		expect(res.isError).toBeUndefined();
		expect(res.content[0].text).toMatch(/tags\[\]|query/i);
	});
});

// ===========================================================================
// PHASE 3 — AUDIT: graph_health audits the folder the tools just wrote
// ===========================================================================

describe("E2E — graph_health (tool → library → audits own output)", () => {
	async function seed() {
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));
		await run("zk_ingest", { files: [f], source: "workflow-jsonl" });
		invalidateCache(vault);
		await run("zk_ingest", { files: [l], source: "workflow-jsonl" });
		invalidateCache(vault);
	}

	test("a freshly-ingested graph is healthy (no dead links, MOC in sync)", async () => {
		await seed();
		const res = await run("graph_health", {});
		expect(res.isError).toBeUndefined();
		expect(res.details.ok).toBe(true);
		// ALL records land on disk (4 = 2 flux2 + 2 ltx, incl. the retired one).
		// graphHealth counts files regardless of status; the retired card is only
		// excluded at QUERY time (retrieveRecords), not from the on-disk count.
		expect(res.details.cardCount).toBe(4);
		expect(res.details.deadLinks.length).toBe(0);
		expect(res.details.mocMissing).toBe(false);
		expect(res.details.mocStale).toBe(false);
	});

	test("MOC drift is detected (delete the MOC → mocMissing)", async () => {
		await seed();
		const { rmSync } = await import("node:fs");
		rmSync(join(vault, MOC));
		invalidateCache(vault);
		const res = await run("graph_health", {});
		expect(res.details.mocMissing).toBe(true);
		expect(res.details.ok).toBe(false);
	});

	test("fix:true heals MOC drift (regenerates the MOC)", async () => {
		await seed();
		const { rmSync } = await import("node:fs");
		rmSync(join(vault, MOC));
		invalidateCache(vault);

		const res = await run("graph_health", { fix: true });
		expect(res.details.ok).toBe(true); // healed
		expect(existsSync(join(vault, MOC))).toBe(true);
	});

	test("report includes the human-readable formatHealth text", async () => {
		await seed();
		const res = await run("graph_health", {});
		const text = res.content[0].text;
		expect(text).toMatch(/card/i);
		expect(text).toMatch(/dead|link|ok/i);
	});
});

// ===========================================================================
// FULL CHAIN — ingest → query → health in one flow (the orchestration proof)
// ===========================================================================

describe("E2E — full deterministic orchestration (write → read → audit)", () => {
	test("the three deterministic tools compose correctly in sequence", async () => {
		// 1. WRITE — ingest flux2 + ltx records
		const f = join(vault, "flux2.knowledge.jsonl");
		const l = join(vault, "ltx.knowledge.jsonl");
		writeFileSync(f, jsonl(FLUX2_RECORDS));
		writeFileSync(l, jsonl(LTX_RECORDS));
		const ingestRes = await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		expect(ingestRes.details.created).toBe(2);
		invalidateCache(vault);
		const ingestRes2 = await run("zk_ingest", { files: [l], source: "workflow-jsonl", source_label: "e2e:ltx" });
		expect(ingestRes2.details.created).toBe(2); // both ltx records written (retired is written too, just excluded from query)
		invalidateCache(vault);

		// 2. READ — query the cross-source "cfg-scale" tag (3 cards: 2 flux2 + 1 ltx)
		const queryRes = await run("knowledge_query", { tags: ["cfg-scale"] });
		expect(queryRes.details.count).toBe(3); // flux2 + ltx converged on cfg-scale
		expect(queryRes.details.scanned).toBeGreaterThanOrEqual(3);
		// the retired card (tags ltx/steps) has no cfg-scale overlap, so it is
		// simply not matched — its status-based exclusion is covered by the
		// dedicated "retired cards are excluded" test above.

		// 3. AUDIT — the folder is healthy (all 4 cards on disk)
		const healthRes = await run("graph_health", {});
		expect(healthRes.details.ok).toBe(true);
		expect(healthRes.details.cardCount).toBe(4);

		// 4. RE-WRITE (idempotency) — re-ingest the flux2 records. No DUPLICATE
		// cards are minted (created == 0). The flux2 cards are marked `updated`
		// rather than `unchanged` here because the ltx cards added in step 1
		// expanded their cross-link neighbourhood — that is correct wiki-aware
		// convergence, not a regression. The byte-stable idempotency guarantee
		// (unchanged on a SECOND identical re-ingest) is proven in the dedicated
		// zk_ingest idempotency test above.
		invalidateCache(vault);
		const reIngest = await run("zk_ingest", { files: [f], source: "workflow-jsonl", source_label: "e2e:flux2" });
		expect(reIngest.details.created).toBe(0); // no duplicates
		expect(reIngest.details.updated + reIngest.details.unchanged).toBe(2);

		// 5. graph still healthy after the no-op re-ingest (MOC not corrupted)
		invalidateCache(vault);
		const healthRes2 = await run("graph_health", {});
		expect(healthRes2.details.ok).toBe(true);
	});
});

// ===========================================================================
// FIXTURE GUARD — the REAL pi-ext-dev extraction, reproducible + test-guarded
// ===========================================================================
// This ingests the shipped fixtures/pi-ext-dev.knowledge.jsonl (the genuine
// pi-extension-development knowledge extracted into the production vault)
// into a temp vault and verifies the full write→read→audit chain. It guards
// the fixture against rot (a malformed/corrupted record fails here loudly) and
// makes the production extraction reproducible: the same fixture + the same
// ingest call is exactly what was run against vaults_root/pi-agent-vault.
// ===========================================================================

import { readFileSync } from "node:fs";
import { parseKnowledgeJsonl } from "../src/ingest.ts";

const FIXTURE = new URL("../fixtures/pi-ext-dev.knowledge.jsonl", import.meta.url).pathname;
const FIXTURE_RECORD_COUNT = 11;

describe("E2E — real pi-ext-dev fixture (reproducible extraction guard)", () => {
	test("the fixture is well-formed: 11 records, zero parse errors", () => {
		const { records, parseErrors } = parseKnowledgeJsonl(readFileSync(FIXTURE, "utf8"));
		expect(parseErrors).toEqual([]);
		expect(records.length).toBe(FIXTURE_RECORD_COUNT);
		// every record has the canonical 12-key schema essentials
		for (const r of records) {
			expect(r.id).toMatch(/^pi-ext-dev:/);
			expect(r.title.length).toBeGreaterThan(10);
			expect(r.tags.length).toBeGreaterThan(0);
		}
	});

	test("ingest the fixture → query it back → audit (the production flow)", async () => {
		// WRITE
		const ingestRes = await run("zk_ingest", {
			files: [FIXTURE],
			source: "workflow-jsonl",
			source_label: "pi-ext-dev:fixture",
		});
		expect(ingestRes.isError).toBeUndefined();
		expect(ingestRes.details.created).toBe(FIXTURE_RECORD_COUNT);
		expect(ingestRes.details.linked).toBeGreaterThan(0); // cross-link edges formed

		// READ — the fixture's shared namespace tag surfaces every card.
		// NOTE: knowledge_query defaults topK=10, so a fixture of 11 needs an
		// explicit topK or the last card is silently dropped — pin that too.
		invalidateCache(vault);
		const capped = await run("knowledge_query", { tags: ["pi-ext-dev"] });
		expect(capped.details.count).toBe(10); // default topK cap

		const queryRes = await run("knowledge_query", { tags: ["pi-ext-dev"], topK: 20 });
		expect(queryRes.details.count).toBe(FIXTURE_RECORD_COUNT);
		// every ingested id is retrievable
		const ids = queryRes.details.cards.map((c: { id: string }) => c.id).sort();
		expect(ids.every((id: string) => id.startsWith("pi-ext-dev:"))).toBe(true);

		// AUDIT — the fixture graph is healthy
		invalidateCache(vault);
		const healthRes = await run("graph_health", {});
		expect(healthRes.details.ok).toBe(true);
		expect(healthRes.details.cardCount).toBe(FIXTURE_RECORD_COUNT);
	});

	test("the fixture ingest is idempotent (byte-stable re-run)", async () => {
		await run("zk_ingest", { files: [FIXTURE], source: "workflow-jsonl", source_label: "pi-ext-dev:fixture" });
		const aCard = join(vault, FOLDER, "pi-ext-dev-extension-is-default-factory-receiving-extensionapi.md");
		const before = readFileSync(aCard, "utf8");
		invalidateCache(vault);
		const re = await run("zk_ingest", { files: [FIXTURE], source: "workflow-jsonl", source_label: "pi-ext-dev:fixture" });
		expect(re.details.created).toBe(0);
		expect(re.details.unchanged).toBe(FIXTURE_RECORD_COUNT);
		expect(readFileSync(aCard, "utf8")).toBe(before); // byte-stable
	});
});
