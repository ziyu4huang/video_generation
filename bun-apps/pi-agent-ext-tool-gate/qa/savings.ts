/**
 * Savings measurement — QA harness (wayfinder ticket 00).
 *
 * Question: does tool-gate's "~9,800 tok/req saved" claim hold?
 *
 * Method (fully offline — no agent boot): reuse the schema-cost CLI's
 * capturing-mock collection (`buildSchemaCostReport`) to get every registered
 * tool's schema-token cost, then sum the cost of the gate-tool names that are
 * actually loaded. At session start (`sticky = effectiveCore`), `filterActive`
 * keeps core + every untracked tool and gates every tracked gate name —
 * so the per-request saving is exactly the token cost of the loaded gate tools.
 *
 * Authority note (resolves map fog "baseline-authority divergence"):
 * tool-gate's RUNTIME `savedTok` telemetry (`computeBannerSaved` →
 * `measureToolTokens`) uses the IDENTICAL heuristic `(desc+params)/4`, so the
 * offline number here and the runtime number agree by construction. The only
 * possible divergence is set membership — a tool loaded at runtime but absent
 * from manifest discovery (or vice versa), reported below as `gateMissing`.
 *
 * Run: `bun run qa:savings`  (wired in package.json)
 */
import {
	buildSchemaCostReport,
	resolveRepoRoot,
} from "../../pi-agent/src/cli/commands/schema-cost.ts";
import type { SchemaCostReport } from "@repo/pi-agent-ext-power-tool/schema-cost";
import { CORPUS_GATES, CORPUS_EFF } from "./evaluate.ts";

/** The savings figure tool-gate's README/banner claims (~9,800 tok/req; zai-mcp env-gated — see caveats()).
 *  THE single source of truth — every prose mention cites ~9,800 and points to
 *  `bun run qa:savings` for live numbers. Do not hardcode a competing figure. */
export const CLAIMED_SAVED_TOK = 9800;

/** Max |savedTok − CLAIMED_SAVED_TOK| before the README/banner claim is stale.
 *  ±20%: the figure legitimately drifts as the gate set and sibling-extension
 *  schemas change — the dominant swing is zai-mcp (~1.1k tok, env-gated on
 *  ZAI_API_KEY ≈ 11% of the claim), so a tighter band would flake whenever zai
 *  loads. 20% still fails loudly if measured savings collapse (claim over-
 *  states) or balloon (claim badly under-states). Upper-edge headroom is thin
 *  by design: with zai-mcp loaded (~+1.1k) measured gross ≈ 10,891 vs the upper
 *  edge 11,760 (~7% headroom) — a high-side "OUTSIDE ✗" correctly signals the
 *  README under-states and needs refresh, NOT a regression. Guarded by the
 *  deviation-band test in savings.test.ts — the lock that makes CLAIMED_SAVED_TOK
 *  trustworthy. */
export const DRIFT_BAND = 0.2; // fraction of CLAIMED_SAVED_TOK

/** Is the measured gross saving within DRIFT_BAND of the claimed figure?
 *  Pure — extracted so the band semantics are unit-testable without booting
 *  the schema-cost collection. */
export function withinDriftBand(savedTok: number): boolean {
	return Math.abs(savedTok - CLAIMED_SAVED_TOK) <= DRIFT_BAND * CLAIMED_SAVED_TOK;
}

/** enable_tool's measured schema-token cost — the always-on overhead tool-gate
 *  pays for its escape hatch. A constant so the net claim DERIVES from the gross
 *  claim (single source, not an independent figure); an overhead-band guard in
 *  savings.test.ts catches its drift (audit I-6 root cause). Refresh via qa:savings. */
export const ENABLE_TOOL_OVERHEAD_TOK = 243;

/** Net savings claim = gross claim − enable_tool overhead. Derived, never
 *  independent. Prose cites ~9,600 (round-to-100); the live measured net is
 *  reported by `bun run qa:savings`. */
export const CLAIMED_NET_TOK = CLAIMED_SAVED_TOK - ENABLE_TOOL_OVERHEAD_TOK; // 9,557

/** Savings-adjacent figures sanctioned to appear as `~N,NNN` literals in prose
 *  (README/CONTEXT/tool-gate.ts header/PRD). The prose-drift test
 *  (savings-prose-lock.test.ts) fails CI if any OTHER comma-grouped thousands
 *  figure appears — closing the prose↔constant gap that let three different
 *  gross numbers (~7,900 / ~7,940 / ~8,050) silently coexist. baseline/gated
 *  are measured approximations refreshed via qa:savings. */
export const SANCTIONED_PROSE_TOK: ReadonlySet<number> = new Set([
	CLAIMED_SAVED_TOK, // ~9,800 gross
	Math.round(CLAIMED_NET_TOK / 100) * 100, // ~9,600 net (claim rounded)
	18_000, // ~18,000 OFF baseline (measured 18,044)
	10_000, // ~10,000 ON gated (measured 9,936)
]);

export interface GateSavings {
	/** First name of the gate — its identity for display. */
	gate: string;
	names: string[];
	tokens: number;
	loaded: boolean;
}

export interface SavingsReport {
	/** Repo root the measurement ran against. */
	root: string;
	/** All tools active (the ungated baseline). */
	offTotal: number;
	/** tool-gate ON at session start (core + untracked, gates fired). */
	gatedTotal: number;
	/** offTotal - gatedTotal. */
	savedTok: number;
	/** savedTok / offTotal * 100. */
	savedPct: number;
	/** Measured schema tokens of enable_tool — the always-on price tool-gate
	 *  pays for its escape hatch (enable_tool exists ONLY because tool-gate
	 *  registers it). 0 if enable_tool isn't in the captured set. */
	enableToolOverhead: number;
	/** savedTok − enableToolOverhead. The honest net: what tool-gate actually
	 *  gains after paying its own escape-hatch overhead. savedTok is GROSS. */
	netSavedTok: number;
	/** netSavedTok / offTotal * 100. */
	netSavedPct: number;
	/** README claim, for deviation reporting. */
	claimed: number;
	/** savedTok - claimed. */
	deviation: number;
	toolCount: number;
	/** Core names found in the captured set (mirrors CORPUS_EFF.core). */
	coreCount: number;
	/** Gate-tool names found in the captured set. */
	gatedToolCount: number;
	perGate: GateSavings[];
	/** Gate-tool names declared in the gate set (hardcoded GATES + reconstructed
	 *  owner-declared gates) but absent from the captured set
	 *  (declared-not-loaded). ONE-DIRECTIONAL by design: it does NOT catch the
	 *  reverse — a tool that is BOTH captured by schema-cost AND declared in
	 *  the gate set but NOT loaded at runtime (a phantom, like the former `cost` gate)
	 *  is invisible here, because it IS in the captured set. The captured==runtime
	 *  invariant is enforced at the source (EXTRA_ENTRIES must be runtime-loaded;
	 *  the manifest is the load truth) + locked by the movie-director-cost test.
	 *  A full captured<->runtime cross-check needs live session data (L2, deferred). */
	gateMissing: string[];
	/** Collection errors from the schema-cost pass. */
	errors: SchemaCostReport["errors"];
}

/** Net savings: gross savedTok minus the always-on overhead tool-gate itself
 *  introduces (enable_tool). Pure — extracted so the net semantics are unit-
 *  testable without booting the schema-cost collection. enable_tool's
 *  promptSnippet+promptGuidelines (~55 tok system-prompt text) are invisible to
 *  measureToolTokens — an unmeasured residual surfaced by caveats(). (audit I-6) */
export function computeNet(
	savedTok: number,
	enableToolOverhead: number,
	offTotal: number,
): { netSavedTok: number; netSavedPct: number } {
	const netSavedTok = savedTok - enableToolOverhead; // NOT clamped — a negative net is an honest red flag
	return { netSavedTok, netSavedPct: offTotal ? Number(((netSavedTok / offTotal) * 100).toFixed(1)) : 0 };
}

/**
 * Measure tool-gate's per-request token savings, offline.
 * Pass an explicit repo `root`, or omit to auto-resolve (walk up to `bun-apps/`).
 */
export async function measureSavings(root?: string): Promise<SavingsReport> {
	const resolved = root ?? resolveRepoRoot();
	const report = await buildSchemaCostReport(resolved);
	const byName = new Map(report.tools.map((t) => [t.name, t.approxTokens]));

	// CORPUS_GATES = CORPUS_EFF.gates, built once via buildEffectiveGates over the
	// corpus tool list (evaluate.ts) — the same effective-gate builder the runtime
	// uses at session_start (ticket 13). Counts every gated tool's tokens so
	// savings reflect owner-declared gated tools, not just the now-empty module
	// GATES fallback. Ticket 13 routed this through buildEffectiveGates; the
	// former "hardcoded GATES + reconstructed" stopgap is obsolete.
	const perGate: GateSavings[] = CORPUS_GATES.map((g) => {
		const present = g.names.filter((n) => byName.has(n));
		const tokens = present.reduce((s, n) => s + (byName.get(n) ?? 0), 0);
		return { gate: g.names[0], names: g.names, tokens, loaded: present.length > 0 };
	});

	const savedTok = perGate.reduce((s, g) => s + g.tokens, 0);
	const offTotal = report.totalTokens;
	const allGateNames = CORPUS_GATES.flatMap((g) => g.names);
	// enable_tool is the always-on price tool-gate pays for its escape hatch —
	// it exists only because tool-gate registers it, so gross savedTok over-
	// states the true gain by its footprint. Net it out (audit I-6).
	const enableToolOverhead = byName.get("enable_tool") ?? 0;
	const { netSavedTok, netSavedPct } = computeNet(savedTok, enableToolOverhead, offTotal);

	return {
		root: resolved,
		offTotal,
		gatedTotal: offTotal - savedTok,
		savedTok,
		savedPct: offTotal ? Number(((savedTok / offTotal) * 100).toFixed(1)) : 0,
		enableToolOverhead,
		netSavedTok,
		netSavedPct,
		claimed: CLAIMED_SAVED_TOK,
		deviation: savedTok - CLAIMED_SAVED_TOK,
		toolCount: report.tools.length,
		coreCount: [...CORPUS_EFF.core].filter((n) => byName.has(n)).length,
		gatedToolCount: allGateNames.filter((n) => byName.has(n)).length,
		perGate,
		gateMissing: allGateNames.filter((n) => !byName.has(n)),
		errors: report.errors,
	};
}

/** Hard structural assertions — the verdict *threshold* is ticket 05's call.
 *  (Collection errors / missing gates are NOT here: they make `savedTok` a
 *  lower bound, not an invalid measurement — surfaced separately by caveats().) */
export function assertSane(r: SavingsReport): string[] {
	const problems: string[] = [];
	if (r.savedTok <= 0) problems.push("savedTok <= 0 — gate removes nothing");
	if (r.gatedTotal >= r.offTotal) problems.push("gatedTotal >= offTotal — no savings");
	// A loaded gate with zero tokens means its schema didn't capture — suspicious.
	for (const g of r.perGate) if (g.loaded && g.tokens === 0) problems.push(`gate '${g.gate}' loaded but 0 tokens`);
	return problems;
}

/** Caveats that make `savedTok` a lower bound (not a hard fail). */
export function caveats(r: SavingsReport): string[] {
	const c: string[] = [];
	if (r.gateMissing.length) c.push(`gate tools NOT loaded (${r.gateMissing.length}): ${r.gateMissing.join(", ")}`);
	if (r.errors.length) for (const e of r.errors) c.push(`collection error — ${e.source}: ${e.error}`);
	if (r.enableToolOverhead > 0) c.push(`enable_tool overhead (${r.enableToolOverhead} tok) is schema-only — its promptSnippet+promptGuidelines (~55 tok system-prompt text) are invisible to measureToolTokens; true net is ~55 lower (audit I-6)`);
	return c;
}

/** Human-readable report. */
export function formatSavings(r: SavingsReport): string[] {
	const sign = (n: number) => (n >= 0 ? "+" : "");
	const lines: string[] = [
		`repo:           ${r.root}`,
		`tools captured: ${r.toolCount}  (core present: ${r.coreCount}/${CORPUS_EFF.core.size}, gated present: ${r.gatedToolCount})`,
		`OFF baseline:   ${r.offTotal.toLocaleString()} tok/req  (all tools active)`,
		`ON at start:    ${r.gatedTotal.toLocaleString()} tok/req  (tool-gate ON, nothing fired)`,
		`SAVED:          ${r.savedTok.toLocaleString()} tok/req  (${r.savedPct}%)  [gross — gated tools' raw tokens]`,
		`enable_tool:    ${r.enableToolOverhead.toLocaleString()} tok/req  (always-on price of gating — drift-detect this)`,
		`NET:            ${r.netSavedTok.toLocaleString()} tok/req  (${r.netSavedPct}%)  [saved − enable_tool; vs claim ~${CLAIMED_NET_TOK.toLocaleString()}: ${sign(r.netSavedTok - CLAIMED_NET_TOK)}${(r.netSavedTok - CLAIMED_NET_TOK).toLocaleString()}]`,
		`vs README claim ~${r.claimed.toLocaleString()}: ${sign(r.deviation)}${r.deviation.toLocaleString()} tok  (±${Math.round(DRIFT_BAND * 100)}% band = ±${Math.round(DRIFT_BAND * r.claimed).toLocaleString()}; ${withinDriftBand(r.savedTok) ? "within ✓" : "OUTSIDE ✗"})`,
		"",
		"per gate (loaded only):",
		...r.perGate
			.filter((g) => g.loaded)
			.sort((a, b) => b.tokens - a.tokens)
			.map((g) => `  ${g.tokens.toString().padStart(5)} tok  ${g.gate}  [${g.names.join(", ")}]`),
	];
	if (r.gateMissing.length) {
		lines.push(`\n⚠ savedTok is a LOWER BOUND — ${r.gateMissing.length} gate tool(s) not loaded`);
	}
	if (r.errors.length) {
		lines.push("", `collection errors:`);
		for (const e of r.errors) lines.push(`  ${e.source}: ${e.error}`);
	}
	return lines;
}

// --- runnable entry ---------------------------------------------------------

async function main() {
	const r = await measureSavings();
	console.log(formatSavings(r).join("\n"));
	const c = caveats(r);
	if (c.length) {
		console.log("\n⚠ CAVEATS (savedTok above is a lower bound):");
		for (const x of c) console.log("  - " + x);
	}
	const problems = assertSane(r);
	if (problems.length) {
		console.error("\n❌ STRUCTURAL FAIL:");
		for (const p of problems) console.error("  - " + p);
		process.exit(1);
	}
	console.log("\n✅ structurally sane (verdict threshold is ticket 05).");
}

// Bun: run only when invoked directly (`bun run qa/savings.ts`).
if (import.meta.main) void main();
