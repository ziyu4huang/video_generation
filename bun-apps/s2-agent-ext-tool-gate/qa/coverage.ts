/**
 * Coverage measurement — QA harness (close the measurement→action loop).
 *
 * Question: which registered tools are heavy (≥ threshold tok/req) but NOT
 * tracked by any tool-gate gate — i.e. candidates the author forgot to gate?
 *
 * power-tool's schema-cost measures every tool's per-request token cost;
 * tool-gate's tracked set (CORE_TOOLS ∪ owner-declared gated tools) is
 * authoritative. If a heavy extension lands but its tools carry no `gating`
 * (and aren't core), tool-gate's fail-open design keeps them always-active
 * (safe — no breakage) but the savings silently degrade. This QA surfaces that
 * gap so the loop closes: schema-cost measures → coverage finds the ungated
 * heavy → author declares `gating` → savings confirms the recovery.
 *
 * Pure core (analyzeCoverage) is separated from the one buildSchemaCostReport
 * call so it is unit-testable against a fixture without booting collection.
 *
 * Run: `bun run qa:coverage`  (wired in package.json)
 */
import { buildSchemaCostReport, resolveRepoRoot } from "../../s2-agent/src/cli/commands/schema-cost.ts";
import type { SchemaCostReport } from "@repo/s2-agent-ext-power-tool/schema-cost";
import { CORPUS_EFF } from "./evaluate.ts";

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
	/** Heavy tools NOT tracked — the findings (sorted desc by tokens). */
	ungated: UngatedTool[];
	/** Heavy tools that ARE tracked — healthy. */
	gatedHeavy: number;
	/** True iff ungated is empty. */
	pass: boolean;
	/** Collection errors from the schema-cost pass (makes `ungated` a LOWER BOUND when non-empty). */
	errors: { source: string; error: string }[];
}

/**
 * Pure: classify a captured report into the coverage verdict. No I/O.
 * Builtins (source === "(builtin)") are never heavy and never reported.
 * `tracked` defaults to CORPUS_EFF.tracked (core ∪ owner-declared gated names) —
 * the effective set production gates on — so migrated gated tools register as
 * covered. The default is computed from pure stub-capture (no agent boot), so
 * pure unit fixtures work without passing it explicitly.
 */
export function analyzeCoverage(
	report: SchemaCostReport,
	threshold: number,
	root: string,
	tracked: Set<string> = CORPUS_EFF.tracked,
): CoverageReport {
	const ungated: UngatedTool[] = [];
	let heavyTools = 0;
	let gatedHeavy = 0;
	for (const t of report.tools) {
		if (t.source === "(builtin)") continue; // builtins can't be gated
		if (t.approxTokens < threshold) continue; // below threshold = not heavy
		heavyTools++;
		if (tracked.has(t.name)) {
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
		errors: report.errors,
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
	if (r.errors.length) {
		lines.push("", `⚠ ungated list is a LOWER BOUND — ${r.errors.length} collection error(s) (see savings caveats for detail)`);
	}
	return lines;
}

/** Hard structural assertions (always-gating if violated). */
export function assertSane(r: CoverageReport): string[] {
	const problems: string[] = [];
	if (!Number.isFinite(r.threshold) || r.threshold <= 0)
		problems.push("threshold must be a positive finite number");
	if (r.totalTools === 0) problems.push("no tools captured — schema-cost collection returned nothing");
	if (r.heavyTools < r.gatedHeavy) problems.push("gatedHeavy > heavyTools — impossible");
	return problems;
}

// --- async collection + runnable entry -------------------------------------

/**
 * Measure coverage against the real repo, offline (capturing-mock collection —
 * no agent boot; same path `qa/savings.ts` uses). Pass an explicit `root`, or
 * omit to auto-resolve (walk up to `bun-apps/`).
 */
export async function measureCoverage(
	root?: string,
	threshold?: number,
): Promise<CoverageReport> {
	const resolved = root ?? resolveRepoRoot();
	const th = threshold ?? DEFAULT_COVERAGE_THRESHOLD;
	const report = await buildSchemaCostReport(resolved);
	return analyzeCoverage(report, th, resolved);
}

async function main() {
	const r = await measureCoverage();
	console.log(formatCoverage(r).join("\n"));
	const problems = assertSane(r);
	if (problems.length) {
		console.error("\n❌ STRUCTURAL FAIL:");
		for (const p of problems) console.error("  - " + p);
		process.exit(1);
	}
	console.log(`\n${r.pass ? "✅" : "❌"} coverage ${r.pass ? "complete" : `gap: ${r.ungated.length} ungated`} (non-gating by default)`);
}

// Bun: run only when invoked directly (`bun run qa:coverage`).
if (import.meta.main) void main();
