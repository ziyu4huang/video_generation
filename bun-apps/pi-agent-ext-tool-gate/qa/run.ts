/**
 * tool-gate QA gate — unified entrypoint (wayfinder tickets 02 / 04 / 05).
 *
 *   bun run qa               default gate (savings floor + L1 intended-behavior)
 *   bun run qa --strict      aspirational bar (fails on any task-breaking gate)
 *   bun run qa --l2          add Layer-2: reachability (deterministic) always;
 *                           live A/B only if --model is given
 *   bun run qa --l2 --model <provider/id>   arm the live A/B (experimental)
 *   bun run qa --json        machine-readable summary on stdout
 *   bun run qa --out <path>  write the markdown report elsewhere
 *
 * Verdict thresholds (ticket 05 — grilling 2026-07-23):
 *   - savings floor: saved ≥ 15% AND ≥ 2,000 tok → gates the default.
 *   - default pass  = savings-floor-met ∧ L1 intended-behavior holds ∧ sane.
 *   - --strict pass = default ∧ ZERO task-breaking gates (blind/misroute).
 *   - false-fires NEVER gate — they're benign (load an unneeded tool; minor
 *     token cost, no task break). They're reported, not counted.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { measureSavings, formatSavings, assertSane, caveats, type SavingsReport } from "./savings.ts";
import {
	measureCoverage,
	formatCoverage,
	assertSane as assertCoverageSane,
	type CoverageReport,
} from "./coverage.ts";
import { evaluateCorpus, tally, type CorpusResult } from "./evaluate.ts";
import { evaluateGateRecall, type GateRecallReport } from "./gate-recall.ts";
import {
	evaluateReachability,
	summarizeReachability,
	formatReachability,
	runLive,
	type ReachabilityResult,
	type ReachabilitySummary,
	type LiveResult,
	type LiveOpts,
} from "./l2.ts";

/** Verdict thresholds (wayfinder ticket 05 — grilling 2026-07-23). */
export const SAVINGS_FLOOR = { pct: 15, tok: 2000 } as const;

export interface QaOptions {
	root?: string;
	strict?: boolean;
	l2?: boolean;
	model?: string;
	out?: string;
	json?: boolean;
	coverageThreshold?: number;
}

export interface L2Block {
	enabled: boolean;
	reachability: ReachabilitySummary | null;
	rows: ReachabilityResult[];
	live: LiveResult;
}

export interface QaResult {
	timestamp: string;
	root: string;
	mode: { strict: boolean; l2: boolean; model?: string };
	savings: SavingsReport;
	coverage: CoverageReport;
	corpus: CorpusResult;
	gateRecall: GateRecallReport;
	l2: L2Block;
	savingsProblems: string[];
	coverageProblems: string[];
	savingsFloorMet: boolean;
	pass: boolean;
	reason: string;
}

export async function runQa(opts: QaOptions = {}): Promise<QaResult> {
	const savings = await measureSavings(opts.root);
	const coverage = await measureCoverage(opts.root, opts.coverageThreshold);
	const corpus = evaluateCorpus();
	const gateRecall = evaluateGateRecall();

	let l2: L2Block;
	if (opts.l2) {
		const rows = evaluateReachability();
		const live = await runLive(undefined, { model: opts.model } as LiveOpts);
		l2 = { enabled: true, reachability: summarizeReachability(rows), rows, live };
	} else {
		l2 = { enabled: false, reachability: null, rows: [], live: { ran: false, reason: "skipped (pass --l2)" } };
	}

	const savingsProblems = assertSane(savings);
	const coverageProblems = assertCoverageSane(coverage);
	const savingsFloorMet = savings.savedPct >= SAVINGS_FLOOR.pct && savings.savedTok >= SAVINGS_FLOOR.tok;
	const sane = savingsProblems.length === 0 && coverageProblems.length === 0;
	const intendedOk = corpus.intendedPass && sane;
	const strictOk = corpus.taskBreakingGates.length === 0; // false-fires excluded
	const strictCoverageOk = coverage.ungated.length === 0; // coverage gate (--strict only)
	const pass =
		(opts.strict ? intendedOk && strictOk && strictCoverageOk : intendedOk) &&
		savingsFloorMet &&
		gateRecall.pass;
	const reason = !savingsFloorMet
		? `savings below floor (need ≥${SAVINGS_FLOOR.pct}% AND ≥${SAVINGS_FLOOR.tok.toLocaleString()} tok; got ${savings.savedPct}%/${savings.savedTok.toLocaleString()})`
		: !corpus.intendedPass
			? `L1 intended-behavior bar failed (see must-fire/must-not-fire/escape cases)`
			: !sane
				? `savings/coverage structurally broken: ${[...savingsProblems, ...coverageProblems].join("; ")}`
				: !gateRecall.pass
					? `gate-recall: ${gateRecall.rows.filter((r) => r.verdict === "FAIL").length} gate(s) below recall floor or with broken controls`
					: opts.strict && !strictOk
					? `--strict: ${corpus.taskBreakingGates.length} task-breaking gate(s) open (${corpus.taskBreakingGates.join(", ")}) — false-fires excluded`
					: opts.strict && !strictCoverageOk
						? `--strict: ${coverage.ungated.length} ungated heavy tool(s) (${coverage.ungated.map((u) => u.name).join(", ")}) — add a gate or confirm always-on`
						: "savings floor met + L1 intended-behavior holds; task-breaking gates + coverage reported (use --strict to gate on them)";

	return {
		timestamp: new Date().toISOString(),
		root: savings.root,
		mode: { strict: !!opts.strict, l2: !!opts.l2, model: opts.model },
		savings,
		coverage,
		corpus,
		gateRecall,
		l2,
		savingsProblems,
		coverageProblems,
		savingsFloorMet,
		pass,
		reason,
	};
}

// ── reporting ───────────────────────────────────────────────────────────────

function verdictGlyph(pass: boolean, strict: boolean) {
	return pass ? "✅ PASS" : `❌ FAIL${strict ? " (--strict)" : ""}`;
}

export function formatReport(r: QaResult): string {
	const c = r.corpus;
	const s = r.savings;
	const lines: string[] = [
		`# tool-gate QA report`,
		``,
		`- **verdict:** ${verdictGlyph(r.pass, r.mode.strict)} — ${r.reason}`,
		`- timestamp: ${r.timestamp}`,
		`- repo: \`${r.root}\``,
		`- mode: ${r.mode.strict ? "strict" : "default"}${r.mode.l2 ? " +l2" : ""}${r.mode.model ? ` --model ${r.mode.model}` : ""}`,
		``,
		`## Savings`,
		...formatSavings(s),
		`- savings floor (≥${SAVINGS_FLOOR.pct}% AND ≥${SAVINGS_FLOOR.tok.toLocaleString()} tok): ${r.savingsFloorMet ? "✅ met" : "❌ NOT met"}`,
		``,
		`## Coverage`,
		...formatCoverage(r.coverage),
		`- coverage verdict: ${r.coverage.pass ? "✅ complete" : `❌ ${r.coverage.ungated.length} ungated`} — ${r.mode.strict ? "GATING (--strict)" : "non-gating by default"}`,
		``,
		`## Layer-1 capability (deterministic)`,
		`- must-fire:     ${tally(c.mustFire)}`,
		`- must-not-fire: ${tally(c.mustNotFire)}`,
		`- escape-name:   ${tally(c.escapeName)}  (of ${c.escapeName.length} gates)`,
		`- escape-intent: ${tally(c.escapeIntent)}`,
		`- coverage gaps: ${c.coverageGaps.length ? c.coverageGaps.join(", ") : "none"}`,
		``,
		`### Task-breaking gates (${c.taskBreakingGates.length}) — ${r.mode.strict ? "GATING (--strict)" : "recoverable via enable_tool({name}); non-gating by default"}`,
		...(c.taskBreakingGates.length
			? c.taskBreakingGates.map((g) => `- \`${g}\` — intent-mode can't reach; name-mode only`)
			: ["- none ✅"]),
		``,
		`### Benign false-fires (${c.precisionRisks.filter((x) => x.fires).length}) — never gate`,
		...c.precisionRisks.filter((x) => x.fires).map((x) => `- [${x.severity}] \`${x.gate}\`: "${x.prompt}" — ${x.why}`),
		``,
		`### Keyword overlaps (${c.overlaps.length})`,
		...c.overlaps.map((o) => `- "${o.keyword}" → ${o.gates.join(" + ")}`),
	];

	if (r.l2.enabled) {
		const rs = r.l2.reachability!;
		lines.push(
			``,
			`## Layer-2 (task-level)`,
			`### Reachability (deterministic) — ${rs.reachable}/${rs.total} reachable, ${rs.gaps} gap(s), ${rs.misroutes} misroute(s)`,
			...formatReachability(r.l2.rows),
			``,
			`### Live usage (A/B on vs off)`,
			`- ${r.l2.live.ran ? "ran" : "not run"} — ${r.l2.live.reason}`,
		);
		if (r.l2.live.results) {
			lines.push("", "| task | intended | ON% | OFF% |", "|---|---|---|---|");
			for (const lr of r.l2.live.results) {
				lines.push(`| ${lr.id} | ${lr.intendedGate} | ${lr.onUsedPct} | ${lr.offUsedPct} |`);
			}
		}
	}

	lines.push(
		``,
		`_Verdict thresholds (ticket 05): savings floor ≥${SAVINGS_FLOOR.pct}%+${SAVINGS_FLOOR.tok.toLocaleString()}tok; strict = zero task-breaking gates; false-fires never gate._`,
	);
	return lines.join("\n");
}

export function formatJson(r: QaResult): string {
	return JSON.stringify(
		{
			verdict: r.pass ? "PASS" : "FAIL",
			reason: r.reason,
			timestamp: r.timestamp,
			mode: r.mode,
			savings: {
				offTotal: r.savings.offTotal,
				gatedTotal: r.savings.gatedTotal,
				savedTok: r.savings.savedTok,
				savedPct: r.savings.savedPct,
			enableToolOverhead: r.savings.enableToolOverhead,
			netSavedTok: r.savings.netSavedTok,
			netSavedPct: r.savings.netSavedPct,
				claimed: r.savings.claimed,
				deviation: r.savings.deviation,
				floorMet: r.savingsFloorMet,
				caveats: caveats(r.savings),
			},
			coverage: {
				threshold: r.coverage.threshold,
				totalTools: r.coverage.totalTools,
				heavyTools: r.coverage.heavyTools,
				gatedHeavy: r.coverage.gatedHeavy,
				ungated: r.coverage.ungated,
				pass: r.coverage.pass,
				collectionErrors: r.coverage.errors,
				structuralProblems: r.coverageProblems,
			},
			l1: {
				mustFire: tally(r.corpus.mustFire),
				mustNotFire: tally(r.corpus.mustNotFire),
				escapeName: tally(r.corpus.escapeName),
				escapeIntent: tally(r.corpus.escapeIntent),
				intendedPass: r.corpus.intendedPass,
				taskBreakingGates: r.corpus.taskBreakingGates,
				benignFalseFires: r.corpus.precisionRisks.filter((x) => x.fires).length,
			},
			l2: r.l2.enabled
				? {
						reachability: r.l2.reachability,
						live: { ran: r.l2.live.ran, reason: r.l2.live.reason, resultCount: r.l2.live.results?.length ?? 0 },
					}
				: { enabled: false },
		},
		null,
		2,
	);
}

// ── runnable entry ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): QaOptions {
	const opts: QaOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--strict") opts.strict = true;
		else if (a === "--l2") opts.l2 = true;
		else if (a === "--model") opts.model = argv[++i];
		else if (a === "--json") opts.json = true;
		else if (a === "--out") opts.out = argv[++i];
		else if (a === "--root") opts.root = argv[++i];
		else if (a === "--coverage-threshold") {
			const n = Number(argv[++i]);
			opts.coverageThreshold = Number.isFinite(n) && n > 0 ? n : undefined;
		}
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const r = await runQa(opts);
	const c = r.corpus;
	const s = r.savings;

	const summary = [
		verdictGlyph(r.pass, r.mode.strict) + ` — ${r.reason}`,
		`savings:   ${s.savedTok.toLocaleString()} tok/req (${s.savedPct}%) — OFF ${s.offTotal.toLocaleString()} → ON ${s.gatedTotal.toLocaleString()}  [floor ${r.savingsFloorMet ? "✅" : "❌"} · vs ~${s.claimed.toLocaleString()}: ${s.deviation >= 0 ? "+" : ""}${s.deviation.toLocaleString()}]  · net ${s.netSavedTok.toLocaleString()} (${s.netSavedPct}%) [saved − enable_tool ${s.enableToolOverhead}]`,
		`L1:        must-fire ${tally(c.mustFire)} · must-not-fire ${tally(c.mustNotFire)} · escape-name ${tally(c.escapeName)} · escape-intent ${tally(c.escapeIntent)}`,
		`coverage:  ${r.coverage.ungated.length} ungated heavy tool(s) · ${r.coverage.gatedHeavy} gated-heavy  [${r.coverage.pass ? "✅" : "❌"}${r.mode.strict ? " --strict gates" : " non-gating"}]`,
		`capability: ${c.taskBreakingGates.length} task-breaking gate(s)${c.taskBreakingGates.length ? ` [${c.taskBreakingGates.join(", ")}]` : ""} · ${c.precisionRisks.filter((x) => x.fires).length} benign false-fire(s) [never gate]${r.mode.strict ? "  ← strict gates on task-breaking" : ""}`,
		`gate-recall: ${r.gateRecall.rows.filter((x) => x.verdict === "PASS").length}/${r.gateRecall.rows.length} gates pass · ${r.gateRecall.uncovered.length} uncovered`,
	];
	if (r.l2.enabled && r.l2.reachability) {
		const rs = r.l2.reachability;
		summary.push(`L2 reach:   ${rs.reachable}/${rs.total} reachable, ${rs.gaps} gap(s)${rs.misroutes ? `, ${rs.misroutes} misroute(s)` : ""}  [${r.l2.live.ran ? "live ran" : "live: " + r.l2.live.reason}]`);
	}

	if (opts.json) {
		process.stdout.write(formatJson(r) + "\n");
	} else {
		process.stdout.write(summary.join("\n") + "\n");
	}

	const outPath = resolve(opts.out ?? "output/tool-gate-qa-report.md");
	try {
		mkdirSync(resolve(outPath, ".."), { recursive: true });
		writeFileSync(outPath, formatReport(r) + "\n");
		process.stderr.write(`report written: ${outPath}\n`);
	} catch (e) {
		process.stderr.write(`(could not write report: ${(e as Error).message})\n`);
	}

	process.exit(r.pass ? 0 : 1);
}

if (import.meta.main) void main();
