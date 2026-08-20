#!/usr/bin/env node
// @ts-nocheck
/**
 * p1-feature-measure.mjs — deterministic before/after measurement for the
 * feature-aware-retrieval cycle (kg-improvement-plan P1).
 *
 * WHAT THIS MEASURES
 *   The cycle adds two levers: (a) a bounded +0.5 ranking boost for
 *   callout-bearing cards in `retrieveRecords` (tie-break only — never beats a
 *   strictly-more-on-tag card), and (b) callout-text surfacing in the digest.
 *   Both are deterministic and live in `retrieveRecords` (the zk-query /
 *   knowledge_query path) + `buildRagTask` (the zk_ask path). This script
 *   measures them directly — no LLM judge — so the delta is attributable to the
 *   code change, not model noise.
 *
 * WHY NOT THE LLM-JUDGE HARNESS (retrieval-quality-self-improve.js)
 *   That harness measures relevance@4 over the *human-authored* vault surface.
 *   A grep of vaults_root/s2-agent-vault (2026-07-07) confirms 0 callouts, 0
 *   embeds, 1 task (a Daily-Note template) across 32 human-authored + 429
 *   converged cards. There is nothing for feature-aware retrieval to act on —
 *   an LLM-judge run over the real surface would show a vacuous zero delta. So
 *   the honest measurement is: (1) record the corpus reality (callouts = 0),
 *   (2) prove the MECHANISM on a synthetic callout corpus (this script), and
 *   (3) ship the additive keys always (harmless when dormant) + ship the
 *   rank/surface levers (bounded, unit-tested, proven by this delta).
 *
 * BEFORE / AFTER
 *   baseline = cards authored as PROSE only (no callout → no feature keys → no
 *              boost, no surfacing). This is the pre-cycle ranking.
 *   post     = the SAME logical cards, but the high-signal ones now carry a
 *              `> [!warning]` callout (→ has_callouts frontmatter → boost +
 *              surfacing fire). This is the post-cycle ranking.
 *
 *   The delta is the change in (a) the rank of a callout card vs an equal-tag
 *   prose card, (b) whether its callout text reaches the digest, and (c) proof
 *   that a strictly-better-tagged prose card is never displaced.
 *
 * OUTPUT: output/p1-feature-measurements/measure-<timestamp>.json (the receipt).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const KC = `${ROOT}/bun-apps/s2-agent-ext-knowledge-card`;
// bun resolves .ts on dynamic import — no build step needed.
const ingestMod = await import(`${KC}/src/ingest.ts`);
const retrieveMod = await import(`${KC}/src/retrieve.ts`);
const { ingestRecords: ingest } = ingestMod;
const { retrieveRecords: retrieve } = retrieveMod;

const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";
const OUT = `${ROOT}/output/p1-feature-measurements`;
mkdirSync(OUT, { recursive: true });

// A synthetic corpus that targets the three measurable properties. Each card
// shares the `argv` tag with the query; BetterTaggedProse adds `argparse` so
// it has strictly MORE tag overlap (must never be displaced by the boost).
//
// ISOLATION: the equal-tag cards use neutral ids where the PROSE card sorts
// FIRST alphabetically ("syn:card-alpha" < "syn:card-beta"). Without the boost
// the prose card wins the id tie-break in baseline — so the high-signal card
// ranking first in post is PROOF the boost fired, not an id-ordering artifact.
function makeRecords({ calloutVariant }) {
	// calloutVariant: false = baseline (prose), true = post (callout in the
	// high-signal card). The prose-only and better-tagged cards are identical
	// in both scenarios — only the "EqualTagHighSignal" card changes.
	const highSignalDetail = calloutVariant
		? "Argv handling intro.\n> [!warning] Reject leading-dash argv — it bypasses path validation.\nFollow up with a guard."
		: "Argv handling intro. Reject leading-dash argv — it bypasses path validation. Follow up with a guard.";
	return [
		{ id: "syn:card-alpha", type: "gotcha", title: "EqualTagProse",
			detail: "A plain mention of argv with no callout.", tags: ["argv"], dimension: "correctness",
			confidence: 0.8, status: "active", superseded_by: null },
		{ id: "syn:card-beta", type: "gotcha", title: "EqualTagHighSignal",
			detail: highSignalDetail, tags: ["argv"], dimension: "correctness",
			confidence: 0.9, status: "active", superseded_by: null },
		{ id: "syn:bettersig-prose", type: "gotcha", title: "BetterTaggedProse",
			detail: "Plain prose about argv + argparse.", tags: ["argv", "argparse"], dimension: "correctness",
			confidence: 0.8, status: "active", superseded_by: null },
	];
}

async function measure(scenario) {
	const vault = mkdtempSync(join(tmpdir(), "p1-measure-"));
	try {
		const recs = makeRecords({ calloutVariant: scenario === "post" });
		await ingest(recs, {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "p1-measure",
			folder: FOLDER, mocPath: MOC,
		});
		const r = await retrieve({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "argparse"], topK: 5,
		});
		const rankOf = (title) => r.cards.findIndex((c) => c.title === title);
		return {
			scenario,
			order: r.cards.map((c) => `${c.title}(shared=${c.sharedTags},callouts=${c.hasCallouts ? 1 : 0})`),
			rankEqualTagHighSignal: rankOf("EqualTagHighSignal"),
			rankEqualTagProse: rankOf("EqualTagProse"),
			rankBetterTaggedProse: rankOf("BetterTaggedProse"),
			highSignalBeatsEqualTagProse:
				rankOf("EqualTagHighSignal") >= 0 && rankOf("EqualTagHighSignal") < rankOf("EqualTagProse"),
			betterTaggedStillFirst: rankOf("BetterTaggedProse") === 0,
			digestHasCalloutText: r.digest.includes("[!warning]"),
			digestHasCalloutHeadline: r.digest.includes("Reject leading-dash argv"),
			digestExcerpt: r.digest.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3),
		};
	} finally {
		rmSync(vault, { recursive: true, force: true });
	}
}

const baseline = await measure("baseline");
const post = await measure("post");

// The ship gate (deterministic analog of "relevance@4 improves OR callout-aware
// context changes ≥1 answer"): post MUST rank the high-signal callout card
// ahead of its equal-tag prose competitor (it loses the id tie-break in
// baseline, so only the boost can flip it), MUST NOT displace the strictly-
// better-tagged prose card, AND MUST surface the callout MARKER (`[!warning]`)
// in the digest (absent in baseline — the headline sentence appears in both
// scenarios, but only post lifts the `[!type]` marker, so the marker is the
// clean surfacing delta signal).
const gate = {
	rankLift: post.rankEqualTagHighSignal < post.rankEqualTagProse
		&& !(baseline.rankEqualTagHighSignal < baseline.rankEqualTagProse),
	noDisplacement: post.betterTaggedStillFirst && baseline.betterTaggedStillFirst,
	surfacingDelta: post.digestHasCalloutText && !baseline.digestHasCalloutText,
};
gate.passed = gate.rankLift && gate.noDisplacement && gate.surfacingDelta;

const corpusReality = {
	vault: `${ROOT}/vaults_root/s2-agent-vault`,
	humanAuthoredCards: 32,
	convergedCards: 429,
	callouts: 0,
	embeds: 0,
	tasks: 1,
	note: "grep 2026-07-07: the real human-authored surface carries 0 callouts/embeds (1 task is a Daily-Note template). Feature-aware retrieval is dormant on the current corpus — the keys are additive/harmless and ready for a future callout-bearing surface.",
};

const shipDecision = gate.passed
	? "SHIP — mechanism proven (rank lift + no displacement + surfacing delta). Additive keys ship always (harmless when dormant on the callout-free corpus); rank/surface levers ship bounded + unit-tested."
	: "REVERT rank/surface — mechanism did NOT meet the deterministic gate. (Additive keys still ship — harmless.)";

const stamp = execSync("date -u +%Y-%m-%dT%H-%M-%S", { encoding: "utf8" }).trim();
const receipt = {
	cycle: "feature-aware-retrieval (P1)",
	timestamp: stamp,
	corpusReality,
	measurement: "deterministic retrieveRecords before/after on a synthetic callout corpus (no LLM judge — corpus has 0 callouts to measure live)",
	baseline, post, gate, shipDecision,
	harnesses: {
		llmJudgeHarness: "retrieval-quality-self-improve.js — NOT run live: the real surface has 0 callouts, so relevance@4 cannot move (vacuous). Documented here as the corpus-reality finding.",
		controlledCorpus: "scripts/controlled-corpus.mjs — indexes papers-docagent/distill; neither domain carries callouts, so it cannot measure this lever either.",
	},
};
const path = `${OUT}/measure-${stamp}.json`;
writeFileSync(path, JSON.stringify(receipt, null, 2));

console.log("=== P1 feature-aware-retrieval measurement ===");
console.log("baseline order:", baseline.order);
console.log("post     order:", post.order);
console.log("gate:", JSON.stringify(gate));
console.log("decision:", shipDecision);
console.log(`receipt: ${path}`);
