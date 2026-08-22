/**
 * Ticket 03 tests — aggregation MOC cards: multi-level derived nodes,
 * idempotent writes, heal orphan pruning (cascade), T2 no-supersede.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import {
	writeAggregationMocs,
	childLinkTarget,
	type WriteAggregationResult,
} from "../src/aggregation-write.ts";
import { healGraph } from "../src/graph-health.ts";
import type { AggregationNode } from "../src/hierarchy.ts";

let vault: string;
let kb: string;
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-aggwrite-"));
	kb = join(vault, FOLDER);
	mkdirSync(kb, { recursive: true });
});
afterAll(() => {
	rmSync(vault, { recursive: true, force: true });
});

function node(id: string, layer: number, parentOf: string[], entities: string[], sources: string[], clusterSize: number): AggregationNode {
	return { id, parentOf, entities, sources, summary: `summary of ${id}`, layer, clusterSize };
}

/** 3-level tree: 4 cards -> 2 layer-0 nodes -> 1 layer-1 node -> 1 root. */
function fixtureNodes(): AggregationNode[] {
	return [
		node("agg:0:0", 0, ["a:one", "a:two"], ["e:a1", "e:a2"], ["h:1", "h:2"], 2),
		node("agg:0:1", 0, ["b:one", "b:two"], ["e:b1", "e:b2"], ["h:3"], 2),
		node("agg:1:0", 1, ["agg:0:0", "agg:0:1"], ["e:a1", "e:a2", "e:b1", "e:b2"], ["h:1", "h:2", "h:3"], 2),
		node("agg:2:0", 2, ["agg:1:0"], ["e:a1", "e:a2", "e:b1", "e:b2"], ["h:1", "h:2", "h:3"], 1),
	];
}

function writeCardFiles() {
	for (const [id, tags] of [["a:one", ["zettel", "gotcha"]], ["a:two", ["zettel", "lever"]], ["b:one", ["zettel", "gotcha"]], ["b:two", ["zettel", "metric"]]] as const) {
		const slug = id.replace(":", "-");
		writeFileSync(
			join(kb, `${slug}.md`),
			`---\nid: ${id}\ncreated: "2026-08-16"\ntags: [${tags.join(", ")}]\n---\n\n# ${slug}\n\n## 核心想法\n\nbody\n`,
		);
	}
}

describe("writeAggregationMocs", () => {
	test("materializes a 3-level tree with correct frontmatter + child links", () => {
		writeCardFiles();
		const r: WriteAggregationResult = writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		expect(r.written.sort()).toEqual(["agg-L0-0.md", "agg-L0-1.md", "agg-L1-0.md", "agg-L2-0.md"]);
		expect(r.skipped).toEqual([]);
		expect(r.refused).toEqual([]);
		expect(r.deleted).toEqual([]);
		for (const n of ["agg-L0-0", "agg-L0-1", "agg-L1-0", "agg-L2-0"]) {
			expect(existsSync(join(kb, `${n}.md`))).toBe(true);
		}

		const { data: d00 } = parseFrontmatter(readFileSync(join(kb, "agg-L0-0.md"), "utf8"));
		expect(d00?.kind).toBe("derived-aggregation");
		expect(d00?.id).toBe("agg:0:0");
		expect(d00?.parent).toBe("agg:1:0");
		expect(Number(d00?.layer)).toBe(0);
		expect(Number(d00?.clusterSize)).toBe(2);
		expect(d00?.generated).toBeTruthy();
		expect(d00?.entities).toEqual(["e:a1", "e:a2"]);
		expect(d00?.sources).toEqual(["h:1", "h:2"]);

		const c00 = readFileSync(join(kb, "agg-L0-0.md"), "utf8");
		expect(c00).toContain("[[a-one]]");
		expect(c00).toContain("[[a-two]]");

		const { data: d20 } = parseFrontmatter(readFileSync(join(kb, "agg-L2-0.md"), "utf8"));
		expect(d20?.parent).toBe(null);

		const c10 = readFileSync(join(kb, "agg-L1-0.md"), "utf8");
		expect(c10).toContain("[[agg-L0-0]]");
		expect(c10).toContain("[[agg-L0-1]]");
	});

	test("idempotent: unchanged nodes are skipped, mtimes untouched", () => {
		writeCardFiles();
		writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		const mtimes = new Map<string, number>();
		for (const n of ["agg-L0-0", "agg-L0-1", "agg-L1-0", "agg-L2-0"]) {
			mtimes.set(n, statSync(join(kb, `${n}.md`)).mtimeMs);
		}
		const r = writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		expect(r.written).toEqual([]);
		expect(r.skipped.sort()).toEqual(["agg-L0-0.md", "agg-L0-1.md", "agg-L1-0.md", "agg-L2-0.md"]);
		for (const [n, m] of mtimes) {
			expect(statSync(join(kb, `${n}.md`)).mtimeMs).toBe(m);
		}
	});

	test("T2: a user card squatting an agg basename is refused, never overwritten", () => {
		writeCardFiles();
		const userContent = "---\nid: my-card\ncreated: \"2026-01-01\"\ntags: [zettel, gotcha]\n---\n\n# agg-L0-0\n\n## 核心想法\n\nuser wrote this\n";
		writeFileSync(join(kb, "agg-L0-0.md"), userContent);
		const r = writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		expect(r.refused).toEqual(["agg-L0-0.md"]);
		expect(readFileSync(join(kb, "agg-L0-0.md"), "utf8")).toBe(userContent);
		// Prune must also never delete it (absent from incoming set, but not derived).
		expect(r.deleted).toEqual([]);
		expect(existsSync(join(kb, "agg-L0-0.md"))).toBe(true);
	});
});

describe("healGraph agg-prune (step 0)", () => {
	test("prunes an orphaned layer-0 node when all its card children are gone", async () => {
		writeCardFiles();
		writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		// Delete BOTH cards under agg:0:1 -> agg-L0-1 has zero live children.
		rmSync(join(kb, "b-one.md"));
		rmSync(join(kb, "b-two.md"));

		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.aggPruned).toEqual([`${FOLDER}/agg-L0-1.md`]);
		expect(existsSync(join(kb, "agg-L0-1.md"))).toBe(false);
		// Survivors intact: agg-L0-0 (a-one/a-two alive), agg-L1-0, agg-L2-0, cards.
		expect(existsSync(join(kb, "agg-L0-0.md"))).toBe(true);
		expect(existsSync(join(kb, "agg-L1-0.md"))).toBe(true);
		expect(existsSync(join(kb, "agg-L2-0.md"))).toBe(true);
		expect(existsSync(join(kb, "a-one.md"))).toBe(true);
	});

	test("cascades: deleting agg-L0-0 + its cards prunes L1 root then L2 root", async () => {
		writeCardFiles();
		writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		// Remove agg-L0-0 AND both its cards -> agg-L1-0 keeps only agg-L0-1
		// (alive) -> survives; instead remove agg-L0-1 too for a full cascade:
		rmSync(join(kb, "a-one.md"));
		rmSync(join(kb, "a-two.md"));
		rmSync(join(kb, "b-one.md"));
		rmSync(join(kb, "b-two.md"));
		// All four cards gone -> both layer-0 nodes orphaned -> agg-L1-0 then
		// agg-L2-0 cascade.
		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.aggPruned.sort()).toEqual([
			`${FOLDER}/agg-L0-0.md`,
			`${FOLDER}/agg-L0-1.md`,
			`${FOLDER}/agg-L1-0.md`,
			`${FOLDER}/agg-L2-0.md`,
		]);
		for (const n of ["agg-L0-0", "agg-L0-1", "agg-L1-0", "agg-L2-0"]) {
			expect(existsSync(join(kb, `${n}.md`))).toBe(false);
		}
	});

	test("never prunes a user-authored agg-named file", async () => {
		writeCardFiles();
		writeAggregationMocs({ kbDir: kb, nodes: fixtureNodes() });
		const userContent = "---\nid: my-card\ncreated: \"2026-01-01\"\ntags: [zettel, gotcha]\n---\n\n# agg-L9-9\n\n## 核心想法\n\nuser\n";
		writeFileSync(join(kb, "agg-L9-9.md"), userContent);
		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.aggPruned).toEqual([]);
		expect(readFileSync(join(kb, "agg-L9-9.md"), "utf8")).toBe(userContent);
	});
});

// ---------------------------------------------------------------------------
// summary frontmatter (ticket 06) — the L1 abstract surface
// ---------------------------------------------------------------------------

describe("renderAggCard summary frontmatter", () => {
	test("renders a clamped `summary:` line; body keeps the full text", () => {
		const dir = mkdtempSync(join(tmpdir(), "zk-aggsum-"));
		try {
			const long = "x".repeat(400);
			const n = node("agg:0:0", 0, ["a-one", "a-two"], ["e1"], ["h:1"], 2);
			n.summary = long;
			writeAggregationMocs({ kbDir: dir, nodes: [n] });
			const c = readFileSync(join(dir, "agg-L0-0.md"), "utf8");
			// frontmatter summary = clampSummary(≤256); body keeps all 400 chars
			const fm = c.slice(0, c.indexOf("\n---\n", 3));
			expect(fm).toContain("summary: ");
			expect(fm.length).toBeLessThan(300 + 200 /* other fm lines */);
			expect(fm).not.toContain(long);
			expect(c).toContain(long); // body ## 摘要 is unclamped (L2 surface)
			// short summary round-trips verbatim in the frontmatter
			const n2 = node("agg:0:1", 0, ["b-one"], ["e2"], ["h:2"], 1);
			writeAggregationMocs({ kbDir: dir, nodes: [n, n2] });
			const c2 = readFileSync(join(dir, "agg-L0-1.md"), "utf8");
			expect(c2).toContain('summary: "summary of agg:0:1"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// childTargets (ticket 06) — id → filename wikilink mapping
// ---------------------------------------------------------------------------

describe("childLinkTarget childTargets map", () => {
	test("a mapped card id links its FILE stem, not the id; unmapped ids keep the legacy fallback", () => {
		const map = new Map([["202405201000", "regional-導致-ghosting-與手部瑕疵的機制"]]);
		expect(childLinkTarget("202405201000", map)).toBe("regional-導致-ghosting-與手部瑕疵的機制");
		// unmapped card id → slugify(id); agg child → basename
		expect(childLinkTarget("202405201999", map)).toBe(childLinkTarget("202405201999"));
		expect(childLinkTarget("agg:1:0", map)).toBe("agg-L1-0");
	});

	test("writeAggregationMocs renders mapped child links into the agg card", () => {
		const dir = mkdtempSync(join(tmpdir(), "zk-aggchild-"));
		try {
			const n = node("agg:0:0", 0, ["202405201000", "agg:1:0"], ["e1"], ["h:1"], 2);
			writeAggregationMocs({
				kbDir: dir,
				nodes: [n, node("agg:1:0", 1, ["202405201001"], ["e2"], ["h:2"], 1)],
				childTargets: new Map([
					["202405201000", "the-first-card-file"],
					["202405201001", "the-second-card-file"],
				]),
			});
			const c = readFileSync(join(dir, "agg-L0-0.md"), "utf8");
			expect(c).toContain("[[the-first-card-file]]");
			expect(c).toContain("[[agg-L1-0]]");
			expect(c).not.toContain("[[202405201000]]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
