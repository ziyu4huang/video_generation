/**
 * 2026-08-31 MOC-staleness fix pair test — the PRODUCTION shape of the
 * hierarchy build lane (leaf cards on disk → buildHierarchy loads them →
 * agg cards land) and the post-build healGraph that folds the agg cards
 * into the MOC.
 *
 * Measured gap (2026-08-30 t14 fold-back receipt run): the build writes
 * agg-L*.md AFTER every MOC regeneration point (ingest heals before the
 * fire), so the MOC goes stale on every build until some later ingest
 * catches it up — graphHealth.mocStale stays true and, in the real vault,
 * the next gitlink bump shifts MOC line numbers under the obsidian A0.9
 * search baseline. This pins the pair contract: build → healGraph → MOC
 * byte-equal to buildMocContent (the graph-health drift seam's expected
 * value).
 *
 * Real temp vault + real ingest — no mocks on the zk side; only embedFn /
 * summarizeFn are deterministic fakes (D4 injected callables).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import { buildHierarchy } from "../src/hierarchy-build.ts";
import { graphHealth, healGraph } from "../src/retrieve.ts";
import { buildMocContent } from "../src/card-format.ts";
import type { KnowledgeRecord } from "../src/types.ts";

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

/** Deterministic fake embedFn: every text → the SAME unit vector, so layer 0
 *  clusters everything into ONE node (≤4 → done, 1 layer). The build only
 *  needs SOME deterministic clustering — the test pins the MOC contract, not
 *  the tree shape. */
const fakeEmbedFn = async (texts: string[]): Promise<number[][]> =>
	texts.map(() => [1, 0]);

const fakeSummarizeFn = async (clusterText: string): Promise<string> =>
	`SUM(${clusterText.length})`;

function rec(id: string, title: string): KnowledgeRecord {
	return {
		id,
		type: "gotcha",
		title,
		detail: `Detail for ${title}.`,
		tags: ["test"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
	};
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-hier-moc-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

describe("hierarchy build → post-build healGraph leaves the MOC fresh", () => {
	test("post-ingest build leaves MOC stale (the gap, pinned); healGraph folds the agg cards in", async () => {
		// 1. Production shape: leaf cards land on disk via ingest (which also
		//    regenerates the MOC over the leaf-only folder).
		await ingestRecords([rec("t:a", "Alpha gotcha"), rec("t:b", "Beta gotcha")], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
			folder: FOLDER,
			mocPath: MOC,
		});

		// 2. The hierarchy build (cards loaded FROM DISK, as the production
		//    lane does) writes agg cards after that MOC regeneration.
		const built = await buildHierarchy({
			kbDir: join(vault, FOLDER),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 1_000_000,
		});
		expect(built.skipped).toBeUndefined();
		expect(built.nodes.length).toBeGreaterThan(0);

		// 3. THE GAP, pinned: the MOC does not know the agg cards exist.
		const before = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(before.mocStale).toBe(true);

		// 4. The post-build heal (what fireHierarchyBuildBestEffort now runs).
		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.mocRegenerated).toBe(true);
		// the orphan cascade must NOT have pruned the fresh agg nodes (their
		// child links target the on-disk leaf cards).
		expect(healed.aggPruned).toEqual([]);

		// 5. Fresh: graphHealth clean AND the on-disk MOC is byte-equal to the
		//    drift seam's expected value (buildMocContent over the folder).
		const after = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(after.mocStale).toBe(false);
		expect(after.ok).toBe(true);
		const folderAbs = join(vault, FOLDER);
		const cardsAbs = readdirSync(folderAbs)
			.filter((n) => n.endsWith(".md"))
			.map((n) => join(folderAbs, n));
		expect(cardsAbs.length).toBeGreaterThan(2); // leaves + agg node(s)
		expect(readFileSync(join(vault, MOC), "utf8")).toBe(buildMocContent(cardsAbs));
	});

	test("a second (idempotent) build + heal changes nothing the MOC can see", async () => {
		await ingestRecords([rec("t:a", "Alpha gotcha"), rec("t:b", "Beta gotcha")], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
			folder: FOLDER,
			mocPath: MOC,
		});
		const kbDir = join(vault, FOLDER);
		await buildHierarchy({ kbDir, embedFn: fakeEmbedFn, summarizeFn: fakeSummarizeFn, tokenBudget: 1_000_000 });
		await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		const mocAfterFirst = readFileSync(join(vault, MOC), "utf8");

		// Resumed build (checkpoints hit, zero embed cost) + heal → same MOC.
		const second = await buildHierarchy({ kbDir, embedFn: fakeEmbedFn, summarizeFn: fakeSummarizeFn, tokenBudget: 1_000_000 });
		expect(second.resumed).toBe(true);
		await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(readFileSync(join(vault, MOC), "utf8")).toBe(mocAfterFirst);
	});
});
