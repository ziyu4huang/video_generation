/// <reference types="bun" />
/**
 * Compare verify-bun-pi-agent-cli run results (JSONL) against the committed
 * baseline (zai/glm-5.2). Purpose: confirm that swapping the DISTILL model
 * keeps quality (knowledge CRUD correctness + stage-2 distill), i.e. the model
 * change is good — not just a pass/fail tally.
 *
 * Result JSONL shape (written by the workflow's Store Results phase):
 *   line 1: {"kind":"summary", model, vlmModel, date, ts, buildOk, byPhase,
 *            totalChecks, passed, failed, regressionStage1Pages, regressionStage2Notes}
 *   then one line per check: {"kind":"check", model, phase, name, passed, detail}
 *
 * Usage (run from anywhere — defaults live next to this script):
 *   bun run .pi/benchmarks/verify-bun-pi-agent-cli/compare.ts <new.jsonl> [more.jsonl ...]
 *   bun run .pi/benchmarks/verify-bun-pi-agent-cli/compare.ts <new.jsonl> <baseline.jsonl>
 *
 * - First positional that resolves to an existing file is a NEW run; the optional
 *   explicit baseline is the LAST arg if two+ files are given AND one is the
 *   committed baseline. Simpler: NEW run(s) = argv, baseline = default unless an
 *   arg literally is the baseline file.
 * - Bare filenames (no "/") resolve against this script's directory.
 */

interface CheckRec {
	kind: "check";
	model: string;
	phase: string;
	name: string;
	passed: boolean;
	detail: string;
}
interface SummaryRec {
	kind: "summary";
	model: string;
	vlmModel?: string;
	date?: string;
	ts?: string;
	buildOk: boolean;
	byPhase: Record<string, string>;
	totalChecks: number;
	passed: number;
	failed: number;
	regressionStage1Pages?: number | null;
	regressionStage2Notes?: number | null;
}
type Rec = CheckRec | SummaryRec;

interface Run {
	summary: SummaryRec | null;
	checks: Map<string, CheckRec>; // key = `${phase}/${name}`
	path: string;
}

import { statSync } from "node:fs";

const HERE = import.meta.dir;
const DEFAULT_BASELINE = `${HERE}/zai-glm-5.2.jsonl`;

/** Bare filenames resolve against HERE; anything with "/" is used as-is. */
function resolvePath(arg: string): string {
	return arg.includes("/") ? arg : `${HERE}/${arg}`;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

async function availableJsonl(): Promise<string[]> {
	return Array.from(
		new Bun.Glob("*.jsonl").scanSync({ cwd: HERE, absolute: false }),
	).sort();
}

async function loadRun(p: string): Promise<Run> {
	if (!(await fileExists(p))) {
		const avail = await availableJsonl();
		console.error(`File not found: ${p}`);
		console.error(
			`Available .jsonl in ${HERE}:\n  ${avail.join("\n  ") || "(none)"}`,
		);
		process.exit(1);
	}
	const text = await Bun.file(p).text();
	const checks = new Map<string, CheckRec>();
	let summary: SummaryRec | null = null;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let rec: Rec;
		try {
			rec = JSON.parse(t) as Rec;
		} catch {
			continue; // skip non-JSON lines
		}
		if (rec.kind === "summary") summary = rec as SummaryRec;
		else if (rec.kind === "check") {
			const c = rec as CheckRec;
			checks.set(`${c.phase}/${c.name}`, c);
		}
	}
	return { summary, checks, path: p };
}

const pad = (s: unknown, w: number) => String(s).padEnd(w);

/** Distill-sensitive checks: knowledge CRUD correctness + regression (incl. stage-2 distill). */
const isDistillRelevant = (key: string) =>
	key.startsWith("knowledge/") || key.startsWith("regression/");

function compareRun(baseline: Run, run: Run): "good" | "degraded" {
	const b = baseline.checks;
	const n = run.checks;
	let degraded = false;
	for (const [key, nc] of n) {
		if (!isDistillRelevant(key)) continue;
		const bc = b.get(key);
		if (bc && bc.passed && !nc.passed) degraded = true; // pass -> fail = regression
	}
	// also flag if knowledge pass-rate dropped overall
	const bKnow = [...b.values()].filter((c) => c.phase === "knowledge");
	const nKnow = [...n.values()].filter((c) => c.phase === "knowledge");
	const bKnowPass = bKnow.filter((c) => c.passed).length;
	const nKnowPass = nKnow.filter((c) => c.passed).length;
	if (nKnowPass < bKnowPass) degraded = true;
	return degraded ? "degraded" : "good";
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		console.error(
			"Usage: compare.ts <new-run.jsonl> [more.jsonl ...] [baseline.jsonl]",
		);
		console.error(`Default baseline: ${DEFAULT_BASELINE}`);
		process.exit(1);
	}

	// If the last arg is (or defaults to) the baseline and there's >1 arg, treat the
	// rest as new runs; otherwise the single arg is the new run and baseline is default.
	let baselinePath = DEFAULT_BASELINE;
	let newArgs = argv;
	const lastResolved = resolvePath(argv[argv.length - 1]);
	if (
		argv.length >= 2 &&
		(lastResolved === DEFAULT_BASELINE ||
			/zai-glm-5\.2\.jsonl$/.test(lastResolved))
	) {
		baselinePath = lastResolved;
		newArgs = argv.slice(0, -1);
	}

	const baseline = await loadRun(resolvePath(baselinePath));
	console.log(
		`BASELINE: ${baseline.summary?.model ?? "?"}  ->  ${baseline.path}\n`,
	);

	for (const arg of newArgs) {
		const run = await loadRun(resolvePath(arg));
		const bs = baseline.summary;
		const ns = run.summary;
		console.log("=".repeat(78));
		console.log(`NEW: ${ns?.model ?? "?"}  ->  ${run.path}`);

		// ── summary table ───────────────────────────────────────────────────────
		console.log("\n=== summary ===");
		console.log(
			`  ${pad("metric", 22)} ${pad("baseline", 14)} ${pad("new", 14)}`,
		);
		if (bs && ns) {
			const rows: [string, unknown, unknown][] = [
				[
					"passed/total",
					`${bs.passed}/${bs.totalChecks}`,
					`${ns.passed}/${ns.totalChecks}`,
				],
				["failed", bs.failed, ns.failed],
				["buildOk", bs.buildOk, ns.buildOk],
				[
					"regStage1Pages",
					bs.regressionStage1Pages ?? "-",
					ns.regressionStage1Pages ?? "-",
				],
				[
					"regStage2Notes",
					bs.regressionStage2Notes ?? "-",
					ns.regressionStage2Notes ?? "-",
				],
			];
			for (const [k, bv, nv] of rows) {
				const mark = String(bv) === String(nv) ? "" : "   <-- differs";
				console.log(`  ${pad(k, 22)} ${pad(bv, 14)} ${pad(nv, 14)}${mark}`);
			}
			console.log(`  ${pad("byPhase", 22)}`);
			const phases = Array.from(
				new Set([...Object.keys(bs.byPhase), ...Object.keys(ns.byPhase)]),
			);
			for (const ph of phases) {
				const bv = bs.byPhase[ph] ?? "-";
				const nv = ns.byPhase[ph] ?? "-";
				const mark = bv === nv ? "" : "   <-- differs";
				console.log(`    ${pad(ph, 20)} ${pad(bv, 14)} ${pad(nv, 14)}${mark}`);
			}
		}

		// ── per-check diff (focus: distill-relevant) ─────────────────────────────
		console.log(
			"\n=== per-check (distill-relevant: knowledge/* + regression/*) ===",
		);
		const allKeys = Array.from(
			new Set([...baseline.checks.keys(), ...run.checks.keys()]),
		).sort();
		let nDiff = 0;
		for (const key of allKeys) {
			if (!isDistillRelevant(key)) continue;
			const bc = baseline.checks.get(key);
			const nc = run.checks.get(key);
			const bp = bc ? (bc.passed ? "PASS" : "fail") : "-";
			const np = nc ? (nc.passed ? "PASS" : "fail") : "-";
			const same = !!bc && !!nc && bc.passed === nc.passed;
			if (!same) nDiff++;
			const flag = same ? "" : "   <-- DIFFERS";
			console.log(`  ${pad(key, 40)} ${pad(bp, 6)} -> ${pad(np, 6)}${flag}`);
		}

		// ── detail for differing distill checks ─────────────────────────────────
		if (nDiff > 0) {
			console.log(`\n=== differing checks: ${nDiff} ===`);
			for (const key of allKeys) {
				if (!isDistillRelevant(key)) continue;
				const bc = baseline.checks.get(key);
				const nc = run.checks.get(key);
				if (!bc || !nc || bc.passed === nc.passed) continue;
				console.log(`\n  [${key}]`);
				console.log(`    baseline: ${bc.detail}`);
				console.log(`    new     : ${nc.detail}`);
			}
		}

		// ── verdict ─────────────────────────────────────────────────────────────
		const verdict = compareRun(baseline, run);
		const tag =
			verdict === "good"
				? "✅ GOOD (distill quality maintained)"
				: "⚠️  DEGRADED (distill quality regressed)";
		console.log(`\nVERDICT [${ns?.model ?? "?"}]: ${tag}\n`);
	}
}

await main();
