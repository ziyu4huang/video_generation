/**
 * Coverage measurement — QA harness (close the measurement→action loop).
 *
 * Question: which registered tools are heavy (≥ threshold tok/req) but NOT
 * tracked by any tool-gate gate — i.e. candidates the author forgot to gate?
 *
 * power-tool's schema-cost measures every tool's per-request token cost;
 * tool-gate's GATES array is hand-maintained. If a heavy extension lands but is
 * never added to a gate, tool-gate's fail-open design keeps it always-active
 * (safe — no breakage) but the savings silently degrade. This QA surfaces that
 * gap so the loop closes: schema-cost measures → coverage finds the ungated
 * heavy → author adds a gate → savings confirms the recovery.
 *
 * Pure core (analyzeCoverage) is separated from the one buildSchemaCostReport
 * call so it is unit-testable against a fixture without booting collection.
 *
 * Run: `bun run qa:coverage`  (wired in package.json)
 */
import type { SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { TRACKED_TOOLS } from "../extensions/tool-gate.ts";

/** Heavy tools at or above this per-request token cost are coverage candidates. */
export const DEFAULT_COVERAGE_THRESHOLD = 300;

/** A heavy tool that no gate tracks. */
export interface UngatedTool {
	name: string;
	tokens: number;
	source: string;
}

/** The coverage verdict. `pass === (ungated.length === 0)`. */
export interface CoverageReport {
	/** Repo root the measurement ran against. */
	root: string;
	/** Token threshold used for this run. */
	threshold: number;
	/** Total tools captured (builtins + extensions). */
	totalTools: number;
	/** Non-builtin tools at/above threshold. */
	heavyTools: number;
	/** Heavy tools NOT in TRACKED_TOOLS — the findings (sorted desc by tokens). */
	ungated: UngatedTool[];
	/** Heavy tools that ARE tracked — healthy. */
	gatedHeavy: number;
	/** True iff ungated is empty. */
	pass: boolean;
}

/**
 * Pure: classify a captured report into the coverage verdict. No I/O.
 * Builtins (source === "(builtin)") are never heavy and never reported.
 */
export function analyzeCoverage(
	report: SchemaCostReport,
	threshold: number,
	root: string,
): CoverageReport {
	const ungated: UngatedTool[] = [];
	let heavyTools = 0;
	let gatedHeavy = 0;
	for (const t of report.tools) {
		if (t.source === "(builtin)") continue; // builtins can't be gated
		if (t.approxTokens < threshold) continue; // below threshold = not heavy
		heavyTools++;
		if (TRACKED_TOOLS.has(t.name)) {
			gatedHeavy++;
			continue;
		}
		ungated.push({ name: t.name, tokens: t.approxTokens, source: t.source });
	}
	ungated.sort((a, b) => b.tokens - a.tokens);
	return {
		root,
		threshold,
		totalTools: report.tools.length,
		heavyTools,
		ungated,
		gatedHeavy,
		pass: ungated.length === 0,
	};
}

/** Human-readable report. */
export function formatCoverage(r: CoverageReport): string[] {
	const lines: string[] = [
		`threshold:   ${r.threshold} tok/req`,
		`tools:       ${r.totalTools} total · ${r.heavyTools} heavy (excl. builtins) · ${r.gatedHeavy} gated-heavy ✅`,
		`ungated:     ${r.ungated.length} heavy tool(s) not tracked by any gate`,
	];
	if (r.ungated.length) {
		lines.push("", "heavy tools NOT gated (candidates the author forgot):");
		for (const u of r.ungated) lines.push(`  ${u.tokens.toString().padStart(5)} tok  ${u.name}  [${u.source}]`);
		lines.push("", "❌ coverage gap — add a GATE entry (extensions/tool-gate.ts) or confirm intentional always-on");
	} else {
		lines.push("", "✅ every heavy tool is tracked by a gate (or is a builtin)");
	}
	return lines;
}

/** Hard structural assertions (always-gating if violated). */
export function assertSane(r: CoverageReport): string[] {
	const problems: string[] = [];
	if (r.threshold <= 0) problems.push("threshold <= 0 — nonsensical");
	if (r.totalTools === 0) problems.push("no tools captured — schema-cost collection returned nothing");
	if (r.heavyTools < r.gatedHeavy) problems.push("gatedHeavy > heavyTools — impossible");
	return problems;
}
