/**
 * Tier-ladder contract tests (context-lifecycle ticket 07, D0/D5).
 *
 * Pins the L0/L1/L2 pre-rendered per-tier text + the OpenViking
 * demote-not-truncate rule (verbatim): an entry that overflows its budget
 * DEMOTES to a shallower tier instead of being truncated. Covers the pure
 * helpers (tier-ladder.ts), the retrieveRecords integration (RetrievedCard
 * .tier/.tiers/.detail), the knowledge_query tool's tier param, and the
 * zk.retrieve host-fn threading.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAggTiers,
	buildLeafTiers,
	renderTier,
	TIER_BUDGETS,
	OVERVIEW_LEAD_CHARS,
} from "../src/tier-ladder.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import { buildRetrieveOptions } from "../src/host-fns.ts";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";

const LONG_BODY = "Sentence one about the lever. ".repeat(40); // ~1,240 chars, > OVERVIEW_LEAD_CHARS

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildLeafTiers", () => {
	test("L0 abstract = title + summary + tags head", () => {
		const tiers = buildLeafTiers({
			title: "Argv gotcha",
			tags: ["argv", "path-safety", "cli"],
			summary: "Reject leading-dash argv.",
			body: LONG_BODY,
		});
		expect(tiers.abstract).toContain("Argv gotcha");
		expect(tiers.abstract).toContain("Reject leading-dash argv.");
		expect(tiers.abstract).toContain("tags: argv, path-safety, cli");
	});

	test("L0 falls back to the deterministic first sentence when summary is absent (pre-v2 cards)", () => {
		const tiers = buildLeafTiers({
			title: "T",
			tags: ["a"],
			body: "First sentence here. Second sentence is longer and must not appear.",
		});
		expect(tiers.abstract).toContain("First sentence here.");
		expect(tiers.abstract).not.toContain("Second sentence");
	});

	test("L1 overview = title + word-boundary lead of the body (<= OVERVIEW_LEAD_CHARS + title)", () => {
		const tiers = buildLeafTiers({ title: "T", tags: [], summary: "s", body: LONG_BODY });
		const lead = tiers.overview.slice("T — ".length);
		expect(lead.length).toBeLessThanOrEqual(OVERVIEW_LEAD_CHARS);
		expect(tiers.overview).toContain("Sentence one");
	});

	test("L2 full = title + the untruncated body", () => {
		const tiers = buildLeafTiers({ title: "T", tags: [], summary: "s", body: LONG_BODY });
		expect(tiers.full).toContain(LONG_BODY.trim());
	});
});

describe("buildAggTiers", () => {
	test("L1 IS the composed summary; L2 bottoms out at it (agg has no deeper body)", () => {
		const tiers = buildAggTiers({ title: "Aggregation L2", tags: ["e1"], summary: "Composed summary." });
		expect(tiers.overview).toBe("Aggregation L2 — Composed summary.");
		expect(tiers.full).toBe(tiers.overview);
		expect(tiers.abstract).toContain("Composed summary.");
	});
});

describe("renderTier — demote-not-truncate (OpenViking rule, verbatim)", () => {
	const tiers = buildLeafTiers({
		title: "T",
		tags: ["argv"],
		summary: "A short summary.",
		body: LONG_BODY,
	});

	test("no caller budget → the requested tier renders as-is (intrinsic budgets)", () => {
		expect(renderTier(tiers, "overview").tier).toBe("overview");
		expect(renderTier(tiers, "overview").text).toBe(tiers.overview);
		expect(renderTier(tiers, "full").text).toBe(tiers.full);
	});

	test("overview overflowing a caller budget DEMOTES to abstract — never a slice of the overview", () => {
		const r = renderTier(tiers, "overview", 40);
		expect(r.tier).toBe("abstract");
		// The rendered text is the ABSTRACT line (title+summary+tags), NOT the
		// first 40 chars of the body lead — that is the whole rule.
		expect(r.text.startsWith("T — ")).toBe(true);
		expect(r.text).toContain("A short summary.");
		expect(r.text).not.toContain("Sentence one");
	});

	test("full overflowing a caller budget demotes THROUGH overview to abstract", () => {
		const r = renderTier(tiers, "full", 40);
		expect(r.tier).toBe("abstract");
		expect(r.text).toContain("A short summary.");
	});

	test("a mid-tier budget keeps overview: overview fits → no demote", () => {
		const r = renderTier(tiers, "overview", TIER_BUDGETS.overview);
		expect(r.tier).toBe("overview");
	});

	test("the abstract floor is word-boundary clamped (nowhere left to demote)", () => {
		const tiers = buildLeafTiers({ title: "T", tags: ["a", "b"], summary: "x".repeat(300), body: "b" });
		const r = renderTier(tiers, "abstract", 50);
		expect(r.tier).toBe("abstract");
		expect(r.text.length).toBeLessThanOrEqual(50);
		expect(r.text.endsWith("…")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// retrieveRecords integration
// ---------------------------------------------------------------------------

describe("retrieveRecords tier ladder (ticket 07)", () => {
	let vault: string;
	const FOLDER = "Zettelkasten/knowledge-graph";

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-tier-"));
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	async function seed(long = false) {
		const rec: KnowledgeRecord = {
			id: "tier:argv", type: "gotcha", title: "Argv gotcha",
			detail: long ? LONG_BODY : "Reject leading-dash argv.", tags: ["argv", "path-safety"],
			dimension: "correctness", confidence: 0.8, status: "active", superseded_by: null,
		};
		return ingestRecords([rec], {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "tier-test", folder: FOLDER,
		});
	}

	test("cards carry tier + pre-rendered tiers; default render is L0 abstract", async () => {
		await seed();
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"] });
		expect(res.count).toBe(1);
		const card = res.cards[0]!;
		expect(card.tier).toBe("abstract");
		expect(card.tiers.abstract).toContain("Argv gotcha");
		expect(card.tiers.overview).toContain("Argv gotcha");
		expect(card.tiers.full).toContain("Reject leading-dash argv.");
		// detail IS the L0 abstract line (title + summary + tags)
		expect(card.detail).toBe(card.tiers.abstract);
		expect(res.digest).toContain("[abstract]");
	});

	test("tier 'overview' renders the L1 lead; tier 'full' renders the whole body", async () => {
		await seed(true);
		const l1 = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], tier: "overview" });
		expect(l1.cards[0]!.tier).toBe("overview");
		expect(l1.cards[0]!.detail).toBe(l1.cards[0]!.tiers.overview);
		const l2 = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], tier: "full" });
		expect(l2.cards[0]!.tier).toBe("full");
		expect(l2.cards[0]!.detail).toBe(l2.cards[0]!.tiers.full);
	});

	test("a budget-capped call DEMOTES rather than truncates (integration)", async () => {
		await seed(true);
		const res = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], tier: "full", maxDetailChars: 60,
		});
		const card = res.cards[0]!;
		expect(card.tier).toBe("abstract"); // full → overview → abstract under the cap
		expect(card.tiers.full.length).toBeGreaterThan(60); // the L2 text still ships verbatim
		expect(card.detail.length).toBeLessThanOrEqual(60); // abstract floor: clamped, not sliced body
	});

	test("ranking is UNCHANGED by the tier option (the ladder is render-only)", async () => {
		await seed(true);
		const ids = async () =>
			(await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], tier: "full" }))
				.cards.map((c) => c.id);
		expect(await ids()).toEqual(
			(await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"] })).cards.map((c) => c.id),
		);
	});
});

// ---------------------------------------------------------------------------
// zk.retrieve host-fn threading
// ---------------------------------------------------------------------------

describe("buildRetrieveOptions tier threading", () => {
	test("default tier is abstract (L0); explicit tier passes through", () => {
		expect(buildRetrieveOptions({}, "/v").tier).toBe("abstract");
		expect(buildRetrieveOptions({ tier: "overview" }, "/v").tier).toBe("overview");
		expect(buildRetrieveOptions({ tier: "full" }, "/v").tier).toBe("full");
	});
});
