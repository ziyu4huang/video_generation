/**
 * resource-tiers hermetic tests (effort 2026-08-25-kcard-resource-tier,
 * ticket 02) — the L0/L1 generation pass with a MOCKED generator seam: no
 * network, no Surreal, no LM Studio. Covers the ticket acceptance: bottom-up
 * order, sidecar frontmatter, level-0/1 rows, ancestor-chain-only refresh,
 * freshness-counter accumulation on wide dirs, L0 extraction clamp, sampling
 * determinism.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateResourceTiers,
	deterministicSample,
	truncateAtSentence,
	extractAbstractFromOverview,
	parseSidecarFrontmatter,
	sidecarBody,
	buildOverviewPrompt,
	TIER_SAMPLE_LIMIT,
	TIER_REFRESH_RATIO,
	TIER_ABSTRACT_MAX_CHARS,
	OVERVIEW_SIDEFILE,
	ABSTRACT_SIDEFILE,
	type TierGenerator,
} from "../src/resource-tiers.ts";
import { buildResourceRows } from "../src/resource-index.ts";

let root: string;

function put(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kcard-tiers-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Mock generator: deterministic markdown in the required output shape whose
 *  brief description DIGESTS the prompt's input section — same inputs → same
 *  output, changed inputs → changed L0 (so the refresh cascade propagates like
 *  a real LLM). Records call order. */
function mockGenerator(): { generator: TierGenerator; calls: string[] } {
	const calls: string[] = [];
	const generator: TierGenerator = (prompt, dirUri) => {
		calls.push(dirUri);
		const name = prompt.match(/\[Directory Name\]\n(.+)/)?.[1]?.trim() ?? "dir";
		const inputs = prompt.slice(prompt.indexOf("[Files and Their Summaries"));
		let h = 0;
		for (const ch of inputs) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		const digest = h.toString(16).slice(0, 8);
		return Promise.resolve(
			[
				`# ${name} Overview`,
				"",
				`${name} covers fixture topics for the corpus (input ${digest}). Alpha routing, beta adapters, and gamma link training are mentioned.`,
				"",
				"## Directory Coverage",
				"",
				"- all direct entries represented",
				"",
				"## Quick Navigation",
				"",
				"- want alpha → see [1]",
				"- want beta → see [2]",
			].join("\n"),
		);
	};
	return { generator, calls };
}

describe("pure helpers", () => {
	test("deterministicSample: within limit → identity; above → evenly-spanned, order-preserving, stable", () => {
		const items = [1, 2, 3];
		expect(deterministicSample(items, 5)).toEqual([1, 2, 3]);
		expect(deterministicSample(items, 1)).toEqual([1]);
		expect(deterministicSample(items, 0)).toEqual([]);
		const wide = Array.from({ length: 100 }, (_, i) => i);
		const a = deterministicSample(wide, 10);
		const b = deterministicSample(wide, 10);
		expect(a).toEqual(b); // stable
		expect(a).toEqual([0, 11, 22, 33, 44, 55, 66, 77, 88, 99]); // evenly spanned, sorted
	});

	test("truncateAtSentence: last sentence end within limit, else first sentence, else word boundary", () => {
		expect(truncateAtSentence("One. Two. Three.", 8)).toBe("One.");
		const noFit = truncateAtSentence("One sentencesuperlong word", 5);
		expect(noFit.length).toBeLessThanOrEqual(5);
		expect(noFit.endsWith("...")).toBe(true); // no sentence end anywhere → word boundary
		const long = "alpha beta gamma delta epsilon zeta";
		expect(truncateAtSentence(long, 15)).toBe("alpha beta...");
	});

	test("extractAbstractFromOverview: prose between H1 and first ##, multi-line joined", () => {
		const md = "# Title\n\nFirst paragraph line one.\nLine two.\n\n## Section\n\nNot included.";
		expect(extractAbstractFromOverview(md)).toBe("First paragraph line one.\nLine two.");
		expect(extractAbstractFromOverview("# Title\n\n\n## Only headers")).toBe("");
	});

	test("abstract clamp enforced at 256 chars, sentence boundary preferred", () => {
		const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about topics.`).join(" ");
		const clamped = truncateAtSentence(sentences, TIER_ABSTRACT_MAX_CHARS);
		expect(clamped.length).toBeLessThanOrEqual(TIER_ABSTRACT_MAX_CHARS);
		expect(clamped.endsWith(".")).toBe(true);
	});
});

describe("generateResourceTiers — bottom-up pass (3-level fixture, mocked LLM)", () => {
	function buildFixture(): void {
		put("top.md", "# Top\n\nTop level prose about the whole tree.");
		put("a/x.md", "# X\n\nAlpha branch leaf about routers.");
		put("a/b/y.md", "# Y\n\nDeepest leaf about link training.");
		put("c/z.md", "# Z\n\nSibling branch leaf about adapters.");
	}

	test("bottom-up order: deepest dir generated before its parent before root", async () => {
		buildFixture();
		const { generator, calls } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		// dirs: a/b (deepest), then a and c (order between siblings free), then root ("" last)
		expect(calls[0]).toBe("a/b");
		expect(calls[calls.length - 1]).toBe("");
		expect(calls).toHaveLength(4);
	});

	test("sidecars land with valid OKF frontmatter; .abstract.md body == extracted L0", async () => {
		buildFixture();
		const { generator } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator, llmModel: "mock-model" });
		for (const dir of [root, join(root, "a"), join(root, "a", "b"), join(root, "c")]) {
			const ovRaw = readFileSync(join(dir, OVERVIEW_SIDEFILE), "utf8");
			const abRaw = readFileSync(join(dir, ABSTRACT_SIDEFILE), "utf8");
			const fm = parseSidecarFrontmatter(ovRaw);
			expect(fm).not.toBeNull();
			expect(fm!.total_entries).toBeGreaterThan(0);
			expect(fm!.sampled_entries).toBe(fm!.total_entries); // small dirs: all sampled
			expect(fm!.unsampled_entries).toBe(0);
			expect(fm!.pending_child_changes).toBe(0);
			expect(fm!.children_fingerprint).toMatch(/^[0-9a-f]{16}$/);
			expect(fm!.generated_model).toBe("mock-model");
			expect(parseSidecarFrontmatter(abRaw)!.children_fingerprint).toBe(fm!.children_fingerprint);
			// L0 = extraction from L1, never a second call (single deterministic helper)
			expect(sidecarBody(abRaw)).toBe(
				truncateAtSentence(
					extractAbstractFromOverview(sidecarBody(ovRaw)),
					TIER_ABSTRACT_MAX_CHARS,
				),
			);
		}
	});

	test("level 0/1 rows derive from sidecars: level, parent, name, abstract", async () => {
		buildFixture();
		const { generator } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		const built = await buildResourceRows({ treePath: root, tree: "fixture", model: "m", embedder: undefined });
		const tiers = built.rows.filter((r) => r.level !== 2);
		// 4 dirs × 2 sidecars = 8 tier rows
		expect(tiers).toHaveLength(8);
		const l0a = tiers.find((r) => r.uri === "a/.abstract.md")!;
		expect(l0a.level).toBe(0);
		expect(l0a.parent).toBeNull(); // described dir "a" is a root-level dir
		expect(l0a.name).toBe("a");
		expect(l0a.abstract).toContain("covers fixture topics");
		const l1b = tiers.find((r) => r.uri === "a/b/.overview.md")!;
		expect(l1b.level).toBe(1);
		expect(l1b.parent).toBe("a"); // described dir "a/b" → parent "a"
		const rootL0 = tiers.find((r) => r.uri === ".abstract.md")!;
		expect(rootL0.parent).toBeNull();
	});

	test("unchanged re-ingest: ZERO LLM calls (idempotent skip)", async () => {
		buildFixture();
		const { generator, calls } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		const first = calls.length;
		const r2 = await generateResourceTiers({ treePath: root, generator });
		expect(r2.llmCalls).toBe(0);
		expect(r2.skipped).toBe(4);
		expect(calls).toHaveLength(first);
	});

	test("child edit → ONLY the ancestor chain refreshes (sibling untouched, counter evidence)", async () => {
		buildFixture();
		const { generator, calls } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		calls.length = 0;
		const siblingSidecar = join(root, "c", OVERVIEW_SIDEFILE);
		const siblingBefore = readFileSync(siblingSidecar, "utf8");

		put("a/x.md", "# X\n\nEDITED alpha branch leaf about routers and clocks.");
		const r2 = await generateResourceTiers({ treePath: root, generator });
		// chain: a (child file changed) → root (a's L0 changed); a/b and c untouched
		expect(calls.sort()).toEqual(["", "a"]);
		expect(r2.refreshed).toBe(2);
		expect(r2.skipped).toBe(2);
		const receiptA = r2.dirs.find((d) => d.uri === "a")!;
		// small dir → refresh-now policy; the pending counter it CARRIED was 1
		expect(receiptA.pendingChildChanges).toBeGreaterThanOrEqual(1);
		// sibling sidecar byte-identical (never rewritten)
		expect(readFileSync(siblingSidecar, "utf8")).toBe(siblingBefore);
	});

	test("deep-leaf edit refreshes the full 3-deep chain, not the sibling branch", async () => {
		buildFixture();
		const { generator, calls } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		calls.length = 0;
		put("a/b/y.md", "# Y\n\nEDITED deepest leaf about redriver equalization.");
		const r2 = await generateResourceTiers({ treePath: root, generator });
		expect(calls.sort()).toEqual(["", "a", "a/b"]);
		expect(r2.refreshed).toBe(3);
		expect(r2.skipped).toBe(1); // c
	});

	test("delta embedding receipt: child edit re-embeds the file + the refreshed chain's sidecars only", async () => {
		buildFixture();
		const { generator } = mockGenerator();
		await generateResourceTiers({ treePath: root, generator });
		const fakeEmbedder = async (texts: string[]): Promise<number[][]> =>
			texts.map(() => new Array(4).fill(0.5));
		await buildResourceRows({ treePath: root, tree: "t", model: "m", embedder: fakeEmbedder });
		put("a/x.md", "# X\n\nEDITED alpha branch leaf about routers and clocks.");
		await generateResourceTiers({ treePath: root, generator });
		const r2 = await buildResourceRows({ treePath: root, tree: "t", model: "m", embedder: fakeEmbedder });
		// 1 edited file + 2 refreshed dirs × 2 sidecars = 5 fresh hashes;
		// 12 total rows (4 files + 8 sidecars) → 7 served from cache
		expect(r2.embedded).toBe(5);
		expect(r2.cached).toBe(7);
	});

	test("generator failure → dir reported failed, no sidecar write, pass continues", async () => {
		buildFixture();
		const failing: TierGenerator = () => Promise.resolve(null);
		const r = await generateResourceTiers({ treePath: root, generator: failing });
		expect(r.failed).toBe(4);
		expect(existsSync(join(root, OVERVIEW_SIDEFILE))).toBe(false);
	});

	test("long-brief child: canonical L0 hashing keeps idempotent re-run at ZERO calls (phantom-refresh regression)", async () => {
		// A child dir whose overview brief description exceeds the 256-char
		// clamp: the parent hashes the child's CLAMPED abstract. Hashing the
		// unclamped extraction instead made the child dir look changed on every
		// re-ingest (caught live 2026-08-25).
		put("leaf/a.md", "# A\n\nLeaf body.");
		put("sibling.md", "# S\n\nSibling body.");
		const longBrief = `${"Very long brief sentence about the leaf directory content. ".repeat(8)}`;
		const gen: TierGenerator = (_prompt, dirUri) =>
			Promise.resolve(`# ${dirUri}\n\n${longBrief}\n\n## Directory Coverage\n\n- all entries`);
		await generateResourceTiers({ treePath: root, generator: gen });
		// sanity: the written abstract IS clamped (sentence boundary inside 256)
		const ab = sidecarBody(readFileSync(join(root, "leaf", ABSTRACT_SIDEFILE), "utf8"));
		expect(ab.length).toBeLessThanOrEqual(TIER_ABSTRACT_MAX_CHARS);
		expect(ab.endsWith(".")).toBe(true);
		const r2 = await generateResourceTiers({ treePath: root, generator: gen });
		expect(r2.llmCalls).toBe(0);
		expect(r2.skipped).toBe(2);
	});
});

describe("freshness policy on wide dirs (mark-pending accumulation)", () => {
	test("single child edit below ratio → pending (no LLM); accumulating past the ratio → refresh", async () => {
		// 40 entries: 1 change = 0.025 < 0.10 → pending; 5 changes = 0.125 ≥ 0.10 → refresh
		for (let i = 1; i <= 40; i++) put(`page-${String(i).padStart(3, "0")}.md`, `# Page ${i}\n\nBody of page ${i}.`);
		const { generator, calls } = mockGenerator();
		const r1 = await generateResourceTiers({ treePath: root, generator });
		expect(r1.refreshed).toBe(1); // root only (flat tree)
		calls.length = 0;

		put("page-001.md", "# Page 1\n\nEDITED body of page 1.");
		const r2 = await generateResourceTiers({ treePath: root, generator });
		expect(r2.pending).toBe(1);
		expect(r2.llmCalls).toBe(0); // below ratio — marked pending, NOT regenerated
		expect(r2.dirs[0]!.pendingChildChanges).toBe(1);

		for (let i = 2; i <= 5; i++) put(`page-${String(i).padStart(3, "0")}.md`, `# Page ${i}\n\nEDITED body of page ${i}.`);
		const r3 = await generateResourceTiers({ treePath: root, generator });
		expect(r3.refreshed).toBe(1); // 5 pending / 40 ≥ 0.10 → refreshed now
		expect(r3.llmCalls).toBe(1);
		const fm = parseSidecarFrontmatter(readFileSync(join(root, OVERVIEW_SIDEFILE), "utf8"))!;
		expect(fm.pending_child_changes).toBe(0); // counter reset at generation
	});

	test("sampling bound: wide dir samples to TIER_SAMPLE_LIMIT, prompt records coverage", async () => {
		for (let i = 1; i <= 100; i++) put(`page-${String(i).padStart(3, "0")}.md`, `# Page ${i}\n\nBody of page ${i}.`);
		let sawPrompt = "";
		const generator: TierGenerator = (prompt) => {
			sawPrompt = prompt;
			return Promise.resolve("# pages\n\nSampled overview text.\n\n## Directory Coverage\n\n- sampled");
		};
		const r = await generateResourceTiers({ treePath: root, generator });
		const receipt = r.dirs[0]!;
		expect(receipt.totalEntries).toBe(100);
		expect(receipt.sampledEntries).toBe(TIER_SAMPLE_LIMIT);
		expect(sawPrompt).toContain("Coverage: sampled");
		expect(sawPrompt).toContain("Direct entries not individually shown: 68"); // 100 − 32
		// sample spans the sequence deterministically (first + last present)
		expect(sawPrompt).toContain("[1] page-001.md");
		expect(sawPrompt).toContain(`[${TIER_SAMPLE_LIMIT}] page-100.md`);
	});

	test("planOnly: decides and reports prompt sizes with ZERO LLM calls and ZERO writes", async () => {
		put("a.md", "# A\n\nBody.");
		const { generator, calls } = mockGenerator();
		const r = await generateResourceTiers({ treePath: root, generator, planOnly: true });
		expect(r.llmCalls).toBe(0);
		expect(calls).toHaveLength(0);
		expect(r.dirs[0]!.action).toBe("refreshed");
		expect(r.dirs[0]!.promptChars).toBeGreaterThan(0);
		expect(existsSync(join(root, OVERVIEW_SIDEFILE))).toBe(false);
	});
});

describe("prompt shape (upstream overview_generation, re-implemented)", () => {
	test("carries dir name, numbered file summaries, child-dir abstracts, coverage", () => {
		const prompt = buildOverviewPrompt({
			dirName: "spec",
			fileSummaries: [{ name: "a.md", abstract: "About alpha." }],
			childDirs: [{ name: "pages", abstract: "Pages subtree." }],
			totalFiles: 1,
			totalChildren: 1,
		});
		expect(prompt).toContain("[Directory Name]\nspec");
		expect(prompt).toContain("[1] a.md: About alpha.");
		expect(prompt).toContain("- pages/: Pages subtree.");
		expect(prompt).toContain("All direct entries are represented");
		expect(prompt).not.toContain("Coverage: sampled");
	});
});
