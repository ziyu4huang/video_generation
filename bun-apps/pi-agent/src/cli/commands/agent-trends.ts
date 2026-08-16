/**
 * `agent-trends` — longitudinal pathology + tool-health trends from session logs.
 *
 * Deterministic command (no LLM, no agent boot): scans the transcript archive,
 * replays the pathology detectors over each historical session, and reports
 * occurrence-rate series plus regression verdicts.
 *
 * All analysis lives in @repo/pi-agent-ext-power-tool/history — this file is only
 * the filesystem wiring and the formatting, mirroring how `tools-metrics` keeps
 * `computeMetrics` pure and separate.
 *
 * Nothing leaves the machine: transcripts contain everything ever typed into a
 * session, so this command reads them locally and prints only aggregate counts
 * — never raw arguments.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AggregateReport,
	type SessionResult,
	aggregate,
	buildScope,
	inScope,
	parseSessionLines,
	replayScan,
	resolveContextPercent,
} from "@repo/pi-agent-ext-power-tool/history";
import type { ParsedArgs } from "../args.ts";

/** Calibrated against the real corpus — see .planning/plans/2026-08-16-*.md. */
const DEFAULT_WINDOW = 200;
const DEFAULT_MIN_EVENTS = 10;
const DEFAULT_DELTA_PCT = 10;

interface FormatContext {
	unmeasurableSessions: number;
}

/** Render the report as terminal lines. PURE. */
export function formatTrendReport(report: AggregateReport, ctx: FormatContext): string[] {
	const out: string[] = [];
	out.push(
		`agent-trends — ${report.totalSessions} tool-using session(s), ${report.windows} window(s)`,
	);
	out.push("");

	if (report.windows < 2) {
		out.push("not enough history for a windowed comparison (need at least 2 full windows)");
		return out;
	}

	for (const v of report.verdicts) {
		const arrow = v.deltaPct > 0 ? "+" : "";
		const tail =
			v.verdict === "insufficient-signal"
				? `insufficient signal (${v.baselineEvents} baseline event(s))`
				: v.verdict;
		out.push(
			`  ${v.check.padEnd(28)} ${String(v.baselineRatePct).padStart(5)}% → ` +
				`${String(v.recentRatePct).padStart(5)}%  (${arrow}${v.deltaPct}pp)  ${tail}`,
		);
	}

	out.push("");
	for (const s of report.series) {
		out.push(`  ${s.check}: ${s.points.map((p) => `${p.ratePct}%`).join(" · ")}`);
	}

	if (ctx.unmeasurableSessions > 0) {
		out.push("");
		out.push(
			`note: context fill was unmeasurable for ${ctx.unmeasurableSessions} session(s) ` +
				"(model context window not in models-store.json); those are excluded from " +
				"context-saturation, not counted as 0%",
		);
	}
	return out;
}

/** Default transcript archive root. */
function resolveSessionsDir(env: NodeJS.ProcessEnv): string {
	return env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

/** Every *.jsonl under every subdirectory of the sessions root. */
function listSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const dir of readdirSync(root)) {
		try {
			for (const f of readdirSync(join(root, dir))) {
				if (f.endsWith(".jsonl")) files.push(join(root, dir, f));
			}
		} catch {
			// unreadable directory — skip
		}
	}
	return files;
}

/** modelId → context window, read shape-agnostically from the models store. */
function loadContextWindows(home: string): Map<string, number> {
	const windows = new Map<string, number>();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(home, ".pi", "agent", "models-store.json"), "utf8"));
	} catch {
		return windows;
	}
	// The store's nesting is not a contract we own, so walk for any {id, contextWindow}.
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (typeof o.id === "string" && typeof o.contextWindow === "number") {
				windows.set(o.id, o.contextWindow);
			}
			for (const x of Object.values(o)) walk(x);
		}
	};
	walk(raw);
	return windows;
}

/** Live worktree roots, main worktree first. Empty on any failure. */
function listWorktrees(cwd: string): string[] {
	try {
		const out = Bun.spawnSync(["git", "-C", cwd, "worktree", "list", "--porcelain"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (out.exitCode !== 0) return [];
		return out.stdout
			.toString()
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

export const agentTrendsCommand = {
	name: "agent-trends",
	summary: "meta: longitudinal pathology + tool-health trends from session logs",
	details: `Usage:
  pi-agent cli agent-trends [options]

Replays the power-tool pathology detectors over every historical transcript in
~/.pi/agent/sessions and reports occurrence-rate series plus regression verdicts.
Nothing is uploaded; nothing derived is persisted — every number is recomputed
from transcripts on each run, so changing a detector threshold re-derives the
entire history consistently.

Sessions with no tool call are excluded: they cannot trigger any detector, and
including them tracks prompt volume rather than agent behaviour.

Scope (default: this repo family):
  --all              Scan every project, not just this repo and its worktrees
  --sessions-dir <p> Override the sessions root (default: ~/.pi/agent/sessions)

Windowing:
  --window <n>       Sessions per comparison window (default: ${DEFAULT_WINDOW})
  --min-events <n>   Baseline occurrences required for a verdict (default: ${DEFAULT_MIN_EVENTS})
  --delta <pp>       Percentage-point move counting as a change (default: ${DEFAULT_DELTA_PCT})

Output:
  --json             Emit a single JSON object to stdout

Examples:
  pi-agent cli agent-trends
  pi-agent cli agent-trends --window 100 --json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const rest = parsed.rest;
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const has = (name: string): boolean => rest.includes(name);
		const num = (name: string, dflt: number): number => {
			const v = flag(name);
			const n = v !== undefined ? Number(v) : Number.NaN;
			return Number.isFinite(n) && n > 0 ? n : dflt;
		};

		const home = homedir();
		const sessionsDir = flag("--sessions-dir") ?? resolveSessionsDir(process.env);
		const windows = loadContextWindows(home);

		const cwd = process.cwd();
		const roots = listWorktrees(cwd);
		const scope = roots.length ? buildScope(roots[0]!, roots) : buildScope(cwd, [cwd]);
		const scanAll = has("--all");

		const rows: SessionResult[] = [];
		let unmeasurable = 0;

		for (const file of listSessionFiles(sessionsDir)) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const scan = parseSessionLines(text.split("\n"));
			if (!scanAll && !inScope(scan.cwd, scope)) continue;
			// Sessions with no tool call cannot trigger any detector; including them
			// would dilute every rate ~3x (measured: 2,226 of 3,391).
			if (scan.calls.length === 0 && scan.results.length === 0) continue;
			if (resolveContextPercent(scan, windows) === null) unmeasurable++;

			const findings = replayScan(scan, { windows });
			rows.push({
				startedAt: scan.startedAt ?? 0,
				checks: [
					...new Set(findings.filter((f) => f.check !== "session-stats").map((f) => f.check)),
				],
			});
		}

		const report = aggregate(rows, {
			windowSize: num("--window", DEFAULT_WINDOW),
			minEvents: num("--min-events", DEFAULT_MIN_EVENTS),
			deltaPct: num("--delta", DEFAULT_DELTA_PCT),
		});

		if (parsed.json || parsed.mode === "json") {
			console.log(JSON.stringify({ ...report, unmeasurableSessions: unmeasurable }, null, 2));
			return;
		}
		for (const line of formatTrendReport(report, { unmeasurableSessions: unmeasurable })) {
			console.log(line);
		}
	},
};
