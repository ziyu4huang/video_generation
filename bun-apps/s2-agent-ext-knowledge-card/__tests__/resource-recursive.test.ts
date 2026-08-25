/**
 * resource-recursive hermetic tests (effort 2026-08-25-kcard-resource-tier,
 * ticket 03) — the heap lane against a scriptable fake SurrealClient, no live
 * Surreal, no network (the fakeClient/_testEmbedder hermeticity contract; the
 * scratch-db round-trip lives in resource-index-live.test.ts).
 *
 * Fixture shape (one tree, three levels):
 *
 *   "" (root)          — .overview.md / .abstract.md   (L1/L0, parent null)
 *   "pages"            — .overview.md / .abstract.md   (L1/L0, parent null —
 *                          sidecar rows' parent is the DESCRIBED dir's parent)
 *   "pages/routers"    — .overview.md / .abstract.md   (L1/L0, parent "pages")
 *   pages/alpha.md, pages/beta.md                      (L2, parent "pages")
 *   pages/routers/alpha-routers.md                     (L2, parent "pages/routers")
 *
 * The fake answers the two statement shapes the lane issues — the seed scan
 * (`WHERE level IN [0, 1]`) and the scoped child fetch (`parent = $p` /
 * `parent IS NULL`) — with caller-planted sim values, so heap order and
 * propagation arithmetic are asserted exactly, not through embedding luck.
 */
import { test, expect, describe } from "bun:test";
import {
	resourceRecursiveQuery,
	describedDirOf,
	RECURSIVE_DEFAULT_ALPHA,
	RECURSIVE_MAX_PARALLEL_CHILD_SEARCHES,
} from "../src/resource-recursive.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

interface FakeRow {
	tree: string;
	uri: string;
	name: string;
	abstract: string;
	level: number;
	parent: string | null;
	sim?: number;
}

/** Fake SurrealClient: routes the lane's two statement shapes to planted rows,
 *  records every statement (expansion order is asserted from the log). */
function fakeClient(opts: {
	tierRows: FakeRow[];
	children?: Record<string, FakeRow[]>; // keyed by parent path ("" = root / IS NULL)
}): { client: SurrealClient; statements: string[] } {
	const statements: string[] = [];
	const client = {
		namespace: "test_ns",
		database: "test_db",
		async query<T>(_sql?: string, _params?: unknown): Promise<T | null> {
			const sql = _sql ?? "";
			statements.push(sql);
			if (/WHERE level IN \[0, 1\]/.test(sql)) return opts.tierRows as T;
			if (/parent IS NULL/.test(sql)) {
				// tier rows themselves are root children too — the lane scores
				// whatever the scan returns; plant them only when intended
				return (opts.children?.[""] ?? []) as T;
			}
			const m = sql.match(/parent = ("(?:[^"\\]|\\.)*")/);
			if (m) {
				const parent = JSON.parse(m[1]) as string;
				return (opts.children?.[parent] ?? []) as T;
			}
			return [] as T;
		},
	} as unknown as SurrealClient;
	return { client, statements };
}

// Deterministic embedder (the _testEmbedder contract): one vec per call is
// enough — the fake plants sims, the query vector only has to exist.
const fakeEmbedder = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);

const tier = (uri: string, level: number, parent: string | null, sim: number): FakeRow => ({
	tree: "fixture",
	uri,
	name: uri,
	abstract: `abstract of ${uri}`,
	level,
	parent,
	sim,
});
const file = (uri: string, parent: string, sim: number): FakeRow => ({
	tree: "fixture",
	uri,
	name: uri,
	abstract: `abstract of ${uri}`,
	level: 2,
	parent,
	sim,
});

describe("describedDirOf — sidecar uri → described directory", () => {
	test("root sidecars → '', nested sidecars → dir path", () => {
		expect(describedDirOf(".overview.md")).toBe("");
		expect(describedDirOf(".abstract.md")).toBe("");
		expect(describedDirOf("pages/.overview.md")).toBe("pages");
		expect(describedDirOf("pages/routers/.abstract.md")).toBe("pages/routers");
	});
});

describe("seed pass", () => {
	test("seeds ranked desc seed the heap in that order; seeds enqueue only — never collect unmixed (reviewer S2)", async () => {
		const { client, statements } = fakeClient({
			tierRows: [
				tier("pages/.overview.md", 1, null, 0.6),
				tier(".overview.md", 1, null, 0.9),
				tier("pages/.abstract.md", 0, null, 0.2),
			],
			children: {},
		});
		const res = await resourceRecursiveQuery({ client, query: "q", tree: "fixture", topK: 10, embedder: fakeEmbedder });
		expect(res.seedCount).toBe(3);
		expect(res.semantic).toBe(true);
		// First expansion is the ROOT dir (seed 0.9), then "pages" (0.6) — the
		// heap-order receipt, read off the statement log.
		const parentQueries = statements.filter((s) => /FROM resource WHERE tree = /.test(s));
		expect(parentQueries[0]).toContain("parent IS NULL");
		expect(parentQueries[1]).toContain(`parent = "pages"`);
		// Upstream shape: the queue is seeded ONLY — with no descent children,
		// the pool stays empty however high the seed sims are.
		expect(res.hits).toHaveLength(0);
	});

	test("zero-sim seeds are dropped (threshold > 0), empty heap → drained, no child queries", async () => {
		const { client, statements } = fakeClient({ tierRows: [tier("pages/.overview.md", 1, null, 0)], children: {} });
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		expect(res.seedCount).toBe(0);
		expect(res.stop).toBe("drained");
		expect(res.rounds).toBe(0);
		expect(statements.filter((s) => /FROM resource WHERE tree = /.test(s))).toHaveLength(0);
	});

	test("out-of-tree tier rows are filtered client-side when a tree is given", async () => {
		const { client } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.9), { ...tier("other/.overview.md", 1, null, 0.95), tree: "other" }],
			children: {},
		});
		const res = await resourceRecursiveQuery({ client, query: "q", tree: "fixture", embedder: fakeEmbedder });
		expect(res.seedCount).toBe(1);
		expect(res.hits.every((h) => h.tree === "fixture")).toBe(true);
	});

	test("a tier row reached via descent collects WITH propagation — never its raw sim", async () => {
		// The root seed 0.9 expands the root; the pages sidecar comes back as a
		// CHILD of the root, so it collects mixed (0.5·0.7+0.5·0.9=0.8), not 0.7.
		const { client } = fakeClient({
			tierRows: [tier(".overview.md", 1, null, 0.9)],
			children: { "": [tier("pages/.overview.md", 1, null, 0.7)] },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", alpha: 0.5, embedder: fakeEmbedder });
		const hit = res.hits.find((h) => h.uri === "pages/.overview.md")!;
		expect(hit).toBeDefined();
		expect(hit.rawSim).toBe(0.7);
		expect(hit.sim).toBeCloseTo(0.8, 12);
		expect(hit.trajectory).toEqual([".overview.md", "pages/.overview.md"]);
	});

	test("maxLevel filters at collection time — a tier-capped top-k never starves (reviewer S1)", async () => {
		// 4 dirs; each returns one L2 leaf (strong) + one L1 sidecar (weak).
		// maxLevel 1 must still surface the sidecars: a post-hoc filter over a
		// top-4 of leaves would return zero.
		const tierRows = [1, 2, 3, 4].map((i) => tier(`d${i}/.overview.md`, 1, null, 0.9));
		const children: Record<string, FakeRow[]> = {};
		for (const i of [1, 2, 3, 4]) {
			children[`d${i}`] = [file(`d${i}/leaf.md`, `d${i}`, 0.8), tier(`d${i}/sub/.overview.md`, 1, `d${i}`, 0.4)];
		}
		const { client } = fakeClient({ tierRows, children });
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 4, maxLevel: 1, embedder: fakeEmbedder });
		expect(res.hits.length).toBe(4);
		expect(res.hits.every((h) => h.level <= 1)).toBe(true);
		// and the L2 leaves are absent by filter, not by rank
		expect(res.hits.some((h) => h.level === 2)).toBe(false);
	});

	test("embedder down → semantic:false, zero statements", async () => {
		const { client, statements } = fakeClient({ tierRows: [], children: {} });
		const down = async (): Promise<number[][]> => {
			throw new Error("endpoint down");
		};
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: down });
		expect(res.semantic).toBe(false);
		expect(statements).toHaveLength(0);
	});

	test("seed-pass Surreal failure → semantic:false (the flat lane's contract, reviewer N3)", async () => {
		const client = {
			namespace: "test_ns",
			database: "test_db",
			async query<T>(_sql?: string): Promise<T | null> {
				if (/WHERE level IN \[0, 1\]/.test(_sql ?? "")) throw new Error("surreal down");
				return [] as T;
			},
		} as unknown as SurrealClient;
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		expect(res.semantic).toBe(false);
		expect(res.hits).toHaveLength(0);
	});
});

describe("propagation arithmetic + trajectory", () => {
	test("final = α·childSim + (1−α)·dirScore; trajectory = seed → hit", async () => {
		const { client } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.8)],
			children: { pages: [file("pages/alpha.md", "pages", 0.6)] },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 5, alpha: 0.5, embedder: fakeEmbedder });
		const hit = res.hits.find((h) => h.uri === "pages/alpha.md")!;
		expect(hit).toBeDefined();
		expect(hit.rawSim).toBe(0.6);
		expect(hit.sim).toBeCloseTo(0.5 * 0.6 + 0.5 * 0.8, 12);
		expect(hit.trajectory).toEqual(["pages/.overview.md", "pages/alpha.md"]);
	});

	test("α is honored end-to-end (0.3 and 7-10ths shapes)", async () => {
		const mk = async (alpha: number) => {
			const { client } = fakeClient({
				tierRows: [tier("pages/.overview.md", 1, null, 0.8)],
				children: { pages: [file("pages/alpha.md", "pages", 0.6)] },
			});
			return (await resourceRecursiveQuery({ client, query: "q", alpha, embedder: fakeEmbedder })).hits.find((h) => h.uri === "pages/alpha.md")!;
		};
		expect((await mk(0.3)).sim).toBeCloseTo(0.3 * 0.6 + 0.7 * 0.8, 12);
		expect((await mk(0.7)).sim).toBeCloseTo(0.7 * 0.6 + 0.3 * 0.8, 12);
	});

	test("default α is 0.5 and rides the result contract", async () => {
		const { client } = fakeClient({ tierRows: [tier("pages/.overview.md", 1, null, 0.8)], children: {} });
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		expect(res.alpha).toBe(RECURSIVE_DEFAULT_ALPHA);
	});

	test("two-level descent chains the trajectory: seed → child tier row → grandchild file", async () => {
		const { client } = fakeClient({
			tierRows: [tier(".overview.md", 1, null, 0.9)],
			children: {
				// root expansion returns the pages sidecar (its parent is null)
				"": [tier("pages/.overview.md", 1, null, 0.7)],
				pages: [tier("pages/routers/.overview.md", 1, "pages", 0.65)],
				"pages/routers": [file("pages/routers/alpha-routers.md", "pages/routers", 0.5)],
			},
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 8, embedder: fakeEmbedder });
		const hit = res.hits.find((h) => h.uri === "pages/routers/alpha-routers.md")!;
		expect(hit).toBeDefined();
		expect(hit.trajectory).toEqual([".overview.md", "pages/.overview.md", "pages/routers/.overview.md", "pages/routers/alpha-routers.md"]);
		// propagated through TWO directory hops:
		// root(0.9) → pages(0.5·0.7+0.5·0.9=0.8) → routers(0.5·0.65+0.5·0.8=0.725)
		// → file 0.5·0.5 + 0.5·0.725 = 0.6125
		expect(hit.sim).toBeCloseTo(0.6125, 12);
	});

	test("negative-sim seeds are threshold-dropped: no descent, no child hits from them", async () => {
		// upstream `_resolve_threshold` default 0.0 with strict `>` — a
		// negative cosine dir never seeds, so the literal-0 branch of the
		// upstream mix quirk is unreachable here (documented in the lane).
		const { client, statements } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, -0.2)],
			children: { pages: [file("pages/alpha.md", "pages", 0.9)] },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		expect(res.seedCount).toBe(0);
		expect(res.hits).toHaveLength(0);
		expect(statements.filter((s) => /FROM resource WHERE tree = /.test(s))).toHaveLength(0);
	});

	test("a child is kept at its BEST-producing path (higher later score wins + trajectory updates)", async () => {
		// alpha.md reachable from two dirs; the better path's trajectory sticks
		const { client } = fakeClient({
			tierRows: [tier("weak/.overview.md", 1, null, 0.2), tier("strong/.overview.md", 1, null, 0.9)],
			children: {
				weak: [file("alpha.md", "weak", 0.9)],
				strong: [file("alpha.md", "strong", 0.8)],
			},
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 5, embedder: fakeEmbedder });
		const hit = res.hits.find((h) => h.uri === "alpha.md")!;
		// weak path: 0.5·0.9+0.5·0.2 = 0.55; strong path: 0.5·0.8+0.5·0.9 = 0.85
		expect(hit.sim).toBeCloseTo(0.85, 12);
		expect(hit.trajectory).toEqual(["strong/.overview.md", "alpha.md"]);
	});
});

describe("L0/L1-only re-enqueue invariant", () => {
	test("an L2 child is terminal: no child query is ever scoped to a file's dirname-from-uri", async () => {
		const { client, statements } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.9)],
			children: { pages: [file("pages/alpha.md", "pages", 0.8)] },
		});
		await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		const parentQueries = statements.filter((s) => /FROM resource WHERE tree = /.test(s));
		// only the sidecar-derived dir was expanded — never "pages/alpha" (a
		// dirname() of a FILE uri, the naive re-enqueue bug)
		expect(parentQueries).toHaveLength(1);
		expect(parentQueries[0]).toContain(`parent = "pages"`);
	});

	test("sidecar children DO re-enqueue their described dir", async () => {
		const { client, statements } = fakeClient({
			tierRows: [tier(".overview.md", 1, null, 0.9)],
			children: {
				"": [tier("pages/.overview.md", 1, null, 0.8)],
				pages: [],
			},
		});
		await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		const parentQueries = statements.filter((s) => /FROM resource WHERE tree = /.test(s));
		expect(parentQueries.some((s) => s.includes(`parent = "pages"`))).toBe(true);
	});
});

describe("convergence + batch bounds", () => {
	test("converged bound: a stable top-k for 3 straight rounds stops BEFORE the heap drains", async () => {
		// 20 dirs seeded, each with its OWN equally-scoring leaf: the pool
		// passes limit in round 1, the top-k (tie-broken uri-asc) is the same
		// set from round 2 on → convergence trips at round 4, leaving 4 of the
		// 20 dirs never expanded — the early-stop receipt.
		const tierRows = Array.from({ length: 20 }, (_, i) => tier(`d${String(i).padStart(2, "0")}/.overview.md`, 1, null, 0.9 - i * 0.001));
		const children: Record<string, FakeRow[]> = {};
		for (let i = 0; i < 20; i++) children[`d${String(i).padStart(2, "0")}`] = [file(`d${String(i).padStart(2, "0")}/leaf.md`, `d${String(i).padStart(2, "0")}`, 0.8)];
		const { client } = fakeClient({ tierRows, children });
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 4, embedder: fakeEmbedder });
		expect(res.stop).toBe("converged");
		expect(res.rounds).toBe(4);
		expect(res.expandedDirs).toBe(16); // 4+4+4+4 — d16..d19 never reached
		expect(res.hits).toHaveLength(4);
		// the uri-asc tie-break holds the SAME four leaves in the top-k
		expect(res.hits.map((h) => h.uri).sort()).toEqual(["d00/leaf.md", "d01/leaf.md", "d02/leaf.md", "d03/leaf.md"]);
	});

	test("stagnant bound: a pool that stops growing BELOW the limit stops at 3 stagnant rounds", async () => {
		// Same wide tree, but limit 30 > pool (21) so the convergence branch's
		// `size >= limit` leg never fires; after round 1 the pool never grows
		// again (common.md already collected, later dirs score lower) → the
		// stagnant counter trips at round 4.
		const tierRows = Array.from({ length: 20 }, (_, i) => tier(`d${String(i).padStart(2, "0")}/.overview.md`, 1, null, 0.9 - i * 0.001));
		const children: Record<string, FakeRow[]> = {};
		for (let i = 0; i < 20; i++) children[`d${String(i).padStart(2, "0")}`] = [file("common.md", `d${String(i).padStart(2, "0")}`, 0.5)];
		const { client } = fakeClient({ tierRows, children });
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 30, embedder: fakeEmbedder });
		expect(res.stop).toBe("stagnant");
		expect(res.rounds).toBe(4);
		expect(res.expandedDirs).toBe(16);
	});

	test("drained: a small tree exhausts the heap without touching either bound", async () => {
		const { client } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.9)],
			children: { pages: [file("pages/alpha.md", "pages", 0.8)] },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 10, embedder: fakeEmbedder });
		expect(res.stop).toBe("drained");
		expect(res.rounds).toBe(1);
		expect(res.expandedDirs).toBe(1);
	});

	test("batch cap: at most RECURSIVE_MAX_PARALLEL_CHILD_SEARCHES dirs expand per round", async () => {
		const tierRows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => tier(`d${i}/.overview.md`, 1, null, 0.9));
		const children: Record<string, FakeRow[]> = {};
		for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) children[`d${i}`] = [file(`d${i}/leaf.md`, `d${i}`, 0.8)];
		const { client } = fakeClient({ tierRows, children });
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 20, embedder: fakeEmbedder });
		expect(RECURSIVE_MAX_PARALLEL_CHILD_SEARCHES).toBe(4);
		// 8 dirs → exactly 2 rounds of 4
		expect(res.rounds).toBe(2);
		expect(res.childSearches).toBe(8);
	});

	test("per-dir child cap: a 30-child dir still ranks correctly under the top-k (cost bound, not a ranking knob)", async () => {
		// cap = max(2·limit, 20) children per directory (upstream's
		// search_children limit). It can never change the final top-limit —
		// the cap is per-dir on sim rank and final is monotonic in sim at a
		// fixed parent — so the observable contract is: a wide dir's best
		// children still rank by propagated score, top-k sliced last.
		const many: FakeRow[] = Array.from({ length: 30 }, (_, i) => file(`pages/f${String(i).padStart(2, "0")}.md`, "pages", i / 100));
		const { client } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.9)],
			children: { pages: many },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 5, embedder: fakeEmbedder });
		expect(res.hits).toHaveLength(5);
		// the propagated-best files are the highest-sim children
		expect(res.hits.map((h) => h.uri)).toEqual(["pages/f29.md", "pages/f28.md", "pages/f27.md", "pages/f26.md", "pages/f25.md"]);
		// and their scores are exact mixes (α=0.5, parent 0.9)
		expect(res.hits.find((h) => h.uri === "pages/f29.md")!.sim).toBeCloseTo(0.5 * 0.29 + 0.5 * 0.9, 12);
	});

	test("per-dir child cap IS observable: a low-sim sidecar ranked past the cap never expands its subtree", async () => {
		// 20 filler files at sims above the sidecar's → the sidecar ranks 21st
		// of 21, past the cap max(2·5, 20): its directory must NEVER be
		// expanded. Break the cap and `parent = "pages/sub"` appears in the
		// statement log — this is the test that fails on that regression.
		const filler: FakeRow[] = Array.from({ length: 20 }, (_, i) => file(`pages/f${String(i).padStart(2, "0")}.md`, "pages", 0.5 + i / 100));
		const { client, statements } = fakeClient({
			tierRows: [tier("pages/.overview.md", 1, null, 0.9)],
			children: { pages: [...filler, tier("pages/sub/.overview.md", 1, "pages", 0.1)], "pages/sub": [file("pages/sub/gold.md", "pages/sub", 0.99)] },
		});
		const res = await resourceRecursiveQuery({ client, query: "q", topK: 5, embedder: fakeEmbedder });
		expect(statements.some((s) => s.includes(`parent = "pages/sub"`))).toBe(false);
		expect(res.hits.some((h) => h.uri === "pages/sub/gold.md")).toBe(false); // pruned with its parent
	});

	test("a failing child query degrades: that dir contributes nothing, the descent continues", async () => {
		const statements: string[] = [];
		const client = {
			namespace: "test_ns",
			database: "test_db",
			async query<T>(_sql?: string): Promise<T | null> {
				const sql = _sql ?? "";
				statements.push(sql);
				if (/WHERE level IN \[0, 1\]/.test(sql)) {
					return [tier("pages/.overview.md", 1, null, 0.9), tier("docs/.overview.md", 1, null, 0.5)] as T;
				}
				if (sql.includes(`parent = "pages"`)) throw new Error("surreal hiccup");
				if (sql.includes(`parent = "docs"`)) return [file("docs/x.md", "docs", 0.8)] as T;
				return [] as T;
			},
		} as unknown as SurrealClient;
		const res = await resourceRecursiveQuery({ client, query: "q", embedder: fakeEmbedder });
		expect(res.semantic).toBe(true);
		expect(res.hits.some((h) => h.uri === "docs/x.md")).toBe(true);
		// pages' expansion failed — nothing from pages reaches the pool
		// (seeds enqueue only, and its child query threw).
		expect(res.hits.some((h) => h.uri.startsWith("pages/"))).toBe(false);
	});
});
