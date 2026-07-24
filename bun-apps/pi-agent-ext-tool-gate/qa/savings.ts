/**
 * Savings measurement — QA harness (wayfinder ticket 00).
 *
 * Question: does tool-gate's "~8,500 tok/req saved" claim hold?
 *
 * Method (fully offline — no agent boot): reuse the schema-cost CLI's
 * capturing-mock collection (`buildSchemaCostReport`) to get every registered
 * tool's schema-token cost, then sum the cost of the gate-tool names that are
 * actually loaded. At session start (`sticky = CORE_TOOLS`), `filterActive`
 * keeps CORE_TOOLS + every untracked tool and gates every tracked gate name —
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
} from "../../pi-agent-cli/src/commands/schema-cost.ts";
import type { SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { CORE_TOOLS, GATES } from "../extensions/tool-gate.ts";

/** The savings figure tool-gate's README/banner claims (~8,500 tok/req; zai-mcp env-gated — see caveats()). */
export const CLAIMED_SAVED_TOK = 8500;

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
	/** tool-gate ON at session start (CORE_TOOLS + untracked, gates fired). */
	gatedTotal: number;
	/** offTotal - gatedTotal. */
	savedTok: number;
	/** savedTok / offTotal * 100. */
	savedPct: number;
	/** README claim, for deviation reporting. */
	claimed: number;
	/** savedTok - claimed. */
	deviation: number;
	toolCount: number;
	/** CORE_TOOLS names found in the captured set. */
	coreCount: number;
	/** Gate-tool names found in the captured set. */
	gatedToolCount: number;
	perGate: GateSavings[];
	/** Gate-tool names NOT loaded (absent from the captured set). */
	gateMissing: string[];
	/** Collection errors from the schema-cost pass. */
	errors: SchemaCostReport["errors"];
}

/**
 * Measure tool-gate's per-request token savings, offline.
 * Pass an explicit repo `root`, or omit to auto-resolve (walk up to `bun-apps/`).
 */
export async function measureSavings(root?: string): Promise<SavingsReport> {
	const resolved = root ?? resolveRepoRoot();
	const report = await buildSchemaCostReport(resolved);
	const byName = new Map(report.tools.map((t) => [t.name, t.approxTokens]));

	const perGate: GateSavings[] = GATES.map((g) => {
		const present = g.names.filter((n) => byName.has(n));
		const tokens = present.reduce((s, n) => s + (byName.get(n) ?? 0), 0);
		return { gate: g.names[0], names: g.names, tokens, loaded: present.length > 0 };
	});

	const savedTok = perGate.reduce((s, g) => s + g.tokens, 0);
	const offTotal = report.totalTokens;
	const allGateNames = GATES.flatMap((g) => g.names);

	return {
		root: resolved,
		offTotal,
		gatedTotal: offTotal - savedTok,
		savedTok,
		savedPct: offTotal ? Number(((savedTok / offTotal) * 100).toFixed(1)) : 0,
		claimed: CLAIMED_SAVED_TOK,
		deviation: savedTok - CLAIMED_SAVED_TOK,
		toolCount: report.tools.length,
		coreCount: [...CORE_TOOLS].filter((n) => byName.has(n)).length,
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
	return c;
}

/** Human-readable report. */
export function formatSavings(r: SavingsReport): string[] {
	const sign = (n: number) => (n >= 0 ? "+" : "");
	const lines: string[] = [
		`repo:           ${r.root}`,
		`tools captured: ${r.toolCount}  (CORE_TOOLS present: ${r.coreCount}/${CORE_TOOLS.size}, gated present: ${r.gatedToolCount})`,
		`OFF baseline:   ${r.offTotal.toLocaleString()} tok/req  (all tools active)`,
		`ON at start:    ${r.gatedTotal.toLocaleString()} tok/req  (tool-gate ON, nothing fired)`,
		`SAVED:          ${r.savedTok.toLocaleString()} tok/req  (${r.savedPct}%)`,
		`vs README claim ~${r.claimed.toLocaleString()}: ${sign(r.deviation)}${r.deviation.toLocaleString()} tok`,
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
