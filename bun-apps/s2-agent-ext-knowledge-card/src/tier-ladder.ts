/**
 * src/tier-ladder.ts — the L0/L1/L2 tier ladder (context-lifecycle ticket 07,
 * D0/D5). Replaces ad-hoc per-renderer truncation with pre-rendered per-tier
 * text + the OpenViking demote-not-truncate rule, verbatim: an entry that
 * overflows its budget DEMOTES to a shallower tier instead of being truncated.
 *
 * Tiers (consumers of the two shipped tiers — L0 card `summary:` frontmatter
 * from ticket 05, L1 agg-node `summary:` from ticket 06):
 *
 *   L0 "abstract"  — title + tags + `summary` frontmatter (deterministic
 *                    first-sentence fallback for pre-v2 cards). The default
 *                    render everywhere.
 *   L1 "overview"  — body lead (~600 chars) for leaf cards / the agg
 *                    `summary` for aggregation nodes. Rendered on a detail
 *                    flag.
 *   L2 "full"      — the full body. Explicit request only; never demoted
 *                    below what the caller's budget forces.
 *
 * Pure + deterministic — no LLM, no network, no fs (callers hand in the
 * already-read card parts).
 */
import { clampSummary } from "./card-format.ts";
import { firstSentenceSummary } from "./extractor.ts";

export type Tier = "abstract" | "overview" | "full";

/** The pre-rendered per-tier text for one card. Every string is
 *  standalone-readable (title included) — a renderer can emit `tiers[tier]`
 *  verbatim. */
export interface TierText {
	/** L0 — title + tags + summary (≤ SUMMARY_MAX_CHARS). */
	abstract: string;
	/** L1 — title + body lead (~600 chars); agg nodes: title + summary. */
	overview: string;
	/** L2 — title + full body; agg nodes bottom out at the L1 summary. */
	full: string;
}

/** L1 body-lead budget. The lead IS the L1 definition (a slice at the front),
 *  not a truncation of it — demotion applies when the CALLER's budget is
 *  smaller than the tier's own text. */
export const OVERVIEW_LEAD_CHARS = 600;

/** Tags surfaced in the L0 abstract (head only — L0 is identification +
 *  gist, not the full tag cloud). */
export const TIER_ABSTRACT_TAG_HEAD = 5;

/** Intrinsic per-tier budgets. Used when the caller passes no explicit
 *  per-entry budget: L0 ≈ title + 256 summary + tags head; L1 ≈ title + lead;
 *  L2 unbounded (explicit request). */
export const TIER_BUDGETS: Record<Tier, number> = {
	abstract: 480,
	overview: OVERVIEW_LEAD_CHARS + 160,
	full: Number.POSITIVE_INFINITY,
};

/** One step shallower on the ladder. The abstract tier is the floor. */
export function demote(tier: Tier): Tier {
	return tier === "full" ? "overview" : "abstract";
}

/** Word-boundary lead slice (no mid-word cut when avoidable, ellipsis tail).
 *  The deterministic lead-shape used by the L1 text. */
function lead(text: string, maxChars: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (s.length <= maxChars) return s;
	return `${s.slice(0, maxChars - 1).replace(/\s+\S*$/, "")}…`;
}

/** Render the L0 abstract line: title — summary (tags: …). */
function abstractLine(title: string, summary: string, tags: string[]): string {
	const tagPart = tags.length > 0 ? ` (tags: ${tags.slice(0, TIER_ABSTRACT_TAG_HEAD).join(", ")})` : "";
	return `${title} — ${summary || "(no summary)"}${tagPart}`;
}

/** Build the ladder for a LEAF card (a ranked vault card). `summary` is the
 *  card's `summary:` frontmatter (schema v2 / ticket 05); when absent
 *  (pre-v2 cards), the deterministic first sentence of the body stands in —
 *  same fallback shape ingest would have written. */
export function buildLeafTiers(args: {
	title: string;
	tags: string[];
	/** `summary:` frontmatter value, undefined/"" when the card predates v2. */
	summary?: string;
	body: string;
}): TierText {
	const summary = (args.summary ?? "").trim() || firstSentenceSummary(args.body);
	return {
		abstract: abstractLine(args.title, clampSummary(summary), args.tags),
		overview: `${args.title} — ${lead(args.body, OVERVIEW_LEAD_CHARS)}`,
		full: `${args.title}\n\n${args.body.trim()}`,
	};
}

/** Build the ladder for a DERIVED AGGREGATION node (ticket 06): L1 IS the
 *  composed `summary:`; L2 bottoms out at it (an agg card has no deeper prose
 *  body to render — its body is the child-link list). */
export function buildAggTiers(args: { title: string; tags: string[]; summary: string }): TierText {
	const summary = clampSummary(args.summary);
	return {
		abstract: abstractLine(args.title, summary, args.tags),
		overview: `${args.title} — ${args.summary.trim() || "(no summary)"}`,
		full: `${args.title} — ${args.summary.trim() || "(no summary)"}`,
	};
}

/** Resolve a requested tier to renderable text under a per-entry budget.
 *  DEMOTE-NOT-TRUNCATE (OpenViking rule): while the tier's text overflows the
 *  budget, step one tier shallower. Only the abstract FLOOR may be clamped
 *  (word-boundary) — it has nowhere left to demote to, and its summary is
 *  already ≤ SUMMARY_MAX_CHARS by construction, so the clamp only trims the
 *  title/tags dressing in pathological cases.
 *
 *  `callerBudget` (optional) caps every tier — the hook ticket 08's
 *  budgeted auto-recall injector threads through (the 350-tok cap /
 *  2×-average-share rule). When omitted, each tier uses its intrinsic budget
 *  (`TIER_BUDGETS`), i.e. nothing demotes and nothing clamps except the
 *  abstract floor against its own budget. */
export function renderTier(
	tiers: TierText,
	requested: Tier,
	callerBudget?: number,
): { text: string; tier: Tier } {
	const budgetFor = (t: Tier): number =>
		Math.min(callerBudget ?? Number.POSITIVE_INFINITY, TIER_BUDGETS[t]);
	let tier = requested;
	while (tier !== "abstract" && tiers[tier].length > budgetFor(tier)) tier = demote(tier);
	const budget = budgetFor(tier);
	const text =
		tier === "abstract" && tiers.abstract.length > budget
			? `${tiers.abstract.slice(0, Math.max(1, budget - 1)).replace(/\s+\S*$/, "")}…`
			: tiers[tier];
	return { text, tier };
}
