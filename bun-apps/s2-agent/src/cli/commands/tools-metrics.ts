/**
 * `tools-metrics` — aggregate per-tool usage metrics from s2-agent session logs.
 *
 * Every s2-agent run appends a JSONL transcript under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Each transcript
 * records, among other things:
 *   - `assistant` messages whose `content[]` contains `{type:"toolCall", id, name, arguments}` blocks
 *   - `toolResult` messages carrying `{toolCallId, toolName, isError}` plus an
 *     event-level ISO `timestamp`
 *
 * This command scans those transcripts and reports, per tool:
 *   calls · results · errors · error% · latency (p50 / p95 / max)
 * where latency is the wall-clock gap between a `toolCall` and its matching
 * `toolResult` (paired by `toolCallId` within the same session).
 *
 * Design mirrors `doctor`: the aggregation (`computeMetrics`) is a PURE function
 * over already-parsed line arrays, so the math is unit-testable with tiny
 * fixture transcripts and zero filesystem access. `run()` wires the real
 * `~/.pi/agent/sessions` tree in.
 *
 * `bashExecution` messages are deliberately IGNORED — they're a separate detail
 * log of bash runs, and the authoritative call/result/error signal already
 * lives on the `bash` tool's `toolCall` + `toolResult` records. Counting both
 * would double-count bash.
 */
import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "../../paths.ts";
import type { ParsedArgs } from "../args.ts";
import {
	buildSchemaCostReport,
	formatSchemaCostReport,
	formatSchemaCostJson,
} from "./schema-cost.ts";
import {
	type CallRec,
	type ResultRec,
	type SessionScan,
	parseSessionLines,
} from "@repo/s2-agent-ext-power-tool/history";

// --- types -------------------------------------------------------------------

// The transcript parser (AnyEvent / CallRec / ResultRec / SessionScan /
// parseSessionLines) now lives in @repo/s2-agent-ext-power-tool/history so that
// tool-health metrics and pathology replay read transcripts through ONE parser.
// Re-exported here because both names were already part of this module's surface.
export type { SessionScan } from "@repo/s2-agent-ext-power-tool/history";
export { parseSessionLines } from "@repo/s2-agent-ext-power-tool/history";

/** Per-tool aggregated numbers. */
export interface ToolStat {
	name: string;
	calls: number;
	results: number;
	errors: number;
	/** Errors followed by a successful same-tool call within RECOVERY_WINDOW results (same session). */
	recoveredErrors: number;
	latencies: number[]; // ms, one per matched result (subset of `results`)
}

/**
 * Recovery window: an error counts as "recovered" if a successful call of the
 * SAME tool follows it within this many same-tool results in the same session.
 * Small → undercounts (legit slow retries missed); large → credits unrelated
 * successes. 3 matches the typical edit/ask_user retry cadence (fail → read → retry).
 */
export const RECOVERY_WINDOW = 3;

/** Aggregate report across all scanned sessions. */
export interface MetricsReport {
	tools: ToolStat[];
	sessions: number;
	files: number;
	firstTs?: number;
	lastTs?: number;
	totalCalls: number;
	totalResults: number;
	totalErrors: number;
}

export interface MetricsFilters {
	sinceMs?: number;
	untilMs?: number;
	cwdSubstr?: string;
}

// --- pure aggregation (unit-testable) ----------------------------------------

/**
 * Aggregate an array of SessionScans into a MetricsReport, applying filters.
 * A session is included iff:
 *   - its `startedAt` (or, failing that, any event) falls in [since, until], AND
 *   - its `cwd` (if `cwdSubstr` set) contains the substring (case-insensitive).
 */
export function computeMetrics(
	scans: SessionScan[],
	filters: MetricsFilters = {},
): MetricsReport {
	const since = filters.sinceMs ?? -Infinity;
	const until = filters.untilMs ?? Infinity;
	const cwdNeedle = filters.cwdSubstr?.toLowerCase();

	const byName = new Map<string, ToolStat>();
	const acc = (name: string): ToolStat => {
		let s = byName.get(name);
		if (!s) {
			s = { name, calls: 0, results: 0, errors: 0, recoveredErrors: 0, latencies: [] };
			byName.set(name, s);
		}
		return s;
	};

	let sessions = 0;
	let files = 0;
	let firstTs: number | undefined;
	let lastTs: number | undefined;

	for (const sc of scans) {
		files++;
		// time-window filter on session start
		const start = sc.startedAt;
		if (start !== undefined && (start < since || start > until)) continue;
		// cwd filter
		if (cwdNeedle && !(sc.cwd ?? "").toLowerCase().includes(cwdNeedle)) continue;

		sessions++;

		if (start !== undefined) {
			if (firstTs === undefined || start < firstTs) firstTs = start;
			if (lastTs === undefined || start > lastTs) lastTs = start;
		}

		// index this session's calls by id for latency pairing, AND keep an ordered
		// per-tool result sequence for recovery detection (errors followed by a
		// successful same-tool call within RECOVERY_WINDOW results).
		const callById = new Map<string, CallRec>();
		const resByTool = new Map<string, ResultRec[]>();
		for (const c of sc.calls) {
			acc(c.name).calls++;
			callById.set(c.callId, c);
		}
		for (const r of sc.results) {
			const st = acc(r.name);
			st.results++;
			if (r.isError) st.errors++;
			let seq = resByTool.get(r.name);
			if (!seq) {
				seq = [];
				resByTool.set(r.name, seq);
			}
			seq.push(r);
			const c = callById.get(r.callId);
			if (c) {
				const dt = r.t1 - c.t0;
				if (Number.isFinite(dt) && dt >= 0) st.latencies.push(dt);
			}
		}
		// recovery: an error is "recovered" iff a successful same-tool result follows
		// within RECOVERY_WINDOW positions in this session's ordered sequence.
		for (const [name, seq] of resByTool) {
			const st = acc(name);
			for (let i = 0; i < seq.length; i++) {
				if (!seq[i]!.isError) continue;
				const hi = Math.min(i + RECOVERY_WINDOW, seq.length - 1);
				for (let j = i + 1; j <= hi; j++) {
					if (!seq[j]!.isError) {
						st.recoveredErrors++;
						break;
					}
				}
			}
		}
	}

	const tools = [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
	return {
		tools,
		sessions,
		files,
		firstTs,
		lastTs,
		totalCalls: sum(tools.map((t) => t.calls)),
		totalResults: sum(tools.map((t) => t.results)),
		totalErrors: sum(tools.map((t) => t.errors)),
	};
}

/** Nearest-rank percentile of a (possibly unsorted) numeric sample. Empty → 0. */
export function percentile(sample: number[], p: number): number {
	if (sample.length === 0) return 0;
	const s = [...sample].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * s.length);
	return s[Math.min(rank - 1, s.length - 1)]!;
}

function sum(xs: number[]): number {
	let t = 0;
	for (const x of xs) t += x;
	return t;
}

// --- formatting --------------------------------------------------------------

/** Human-friendly duration: <1s → "Nms", else "X.Xs". 0 → "-". */
function fmtMs(ms: number): string {
	if (!ms || !Number.isFinite(ms)) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function pct(n: number, d: number): string {
	if (!d) return "0%";
	return `${((n / d) * 100).toFixed(1)}%`;
}

/** Human date from epoch ms (undefined → "-"). */
function fmtDate(ms: number | undefined): string {
	if (ms === undefined) return "-";
	return new Date(ms).toISOString().slice(0, 10);
}

export interface FormatOpts {
	details?: boolean;
	top?: number;
	toolFilter?: string[]; // substrings; empty = all
}

/** Render the report as plain-text lines (human mode). */
export function formatReport(report: MetricsReport, opts: FormatOpts = {}): string[] {
	const lines: string[] = [];
	const tools = report.tools.filter((t) => {
		if (!opts.toolFilter || opts.toolFilter.length === 0) return true;
		return opts.toolFilter.some((f) => t.name.includes(f));
	});
	const shown = opts.top && opts.top > 0 ? tools.slice(0, opts.top) : tools;

	if (shown.length === 0) {
		lines.push("No tool calls matched the given filters.");
		return lines;
	}

	// header + summary
	lines.push(
		`tools-metrics — ${report.totalCalls.toLocaleString()} calls · ` +
			`${report.totalResults.toLocaleString()} results · ` +
			`${report.totalErrors.toLocaleString()} errors (${pct(report.totalErrors, report.totalResults)})`,
	);
	lines.push(
		`sessions: ${report.sessions}  files scanned: ${report.files}  ` +
			`range: ${fmtDate(report.firstTs)} → ${fmtDate(report.lastTs)}  ` +
			`tools: ${report.tools.length}`,
	);
	lines.push("");

	if (opts.details) {
		const rows = shown.map((t) => ({
			tool: t.name,
			calls: String(t.calls),
			results: String(t.results),
			errors: String(t.errors),
			"err%": pct(t.errors, t.results),
			"recov%": pct(t.recoveredErrors, t.errors),
			p50: fmtMs(percentile(t.latencies, 50)),
			p95: fmtMs(percentile(t.latencies, 95)),
			max: fmtMs(Math.max(0, ...t.latencies)),
			mean: fmtMs(t.latencies.length ? sum(t.latencies) / t.latencies.length : 0),
		}));
		printTable(lines, rows, [
			"tool", "calls", "results", "errors", "err%", "recov%", "p50", "p95", "max", "mean",
		]);
	} else {
		const rows = shown.map((t) => ({
			tool: t.name,
			calls: String(t.calls),
			results: String(t.results),
			errors: String(t.errors),
			"err%": pct(t.errors, t.results),
			p50: fmtMs(percentile(t.latencies, 50)),
		}));
		printTable(lines, rows, ["tool", "calls", "results", "errors", "err%", "p50"]);
	}

	if (opts.top && tools.length > shown.length) {
		lines.push(`(${tools.length - shown.length} more tools hidden — raise --top or use --tool <name>)`);
	}
	return lines;
}

/** Append a right-aligned column table to `lines`. */
function printTable(
	lines: string[],
	rows: Record<string, string>[],
	cols: string[],
): void {
	if (rows.length === 0) return;
	const numeric = new Set(["calls", "results", "errors", "err%", "recov%", "p50", "p95", "max", "mean"]);
	const widths = cols.map(
		(c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
	);
	const fmt = (r: Record<string, string>) =>
		cols
			.map((c, i) => {
				const v = String(r[c] ?? "");
				return numeric.has(c) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!);
			})
			.join("  ")
			.trimEnd();
	const header = Object.fromEntries(cols.map((c) => [c, c])) as Record<string, string>;
	lines.push(fmt(header));
	for (const r of rows) lines.push(fmt(r));
}

/** Render the report as a single JSON object (machine mode). */
export function formatJson(report: MetricsReport, opts: FormatOpts = {}): string {
	const tools = report.tools.filter((t) => {
		if (!opts.toolFilter || opts.toolFilter.length === 0) return true;
		return opts.toolFilter.some((f) => t.name.includes(f));
	});
	const shown = opts.top && opts.top > 0 ? tools.slice(0, opts.top) : tools;
	const lat = (s: number[]) => ({
		p50: percentile(s, 50),
		p95: percentile(s, 95),
		max: s.length ? Math.max(...s) : 0,
		mean: s.length ? Math.round(sum(s) / s.length) : 0,
		n: s.length,
	});
	return JSON.stringify(
		{
			sessions: report.sessions,
			files: report.files,
			range: { first: report.firstTs, last: report.lastTs },
			totals: {
				calls: report.totalCalls,
				results: report.totalResults,
				errors: report.totalErrors,
				errorRate: report.totalResults ? report.totalErrors / report.totalResults : 0,
				tools: report.tools.length,
			},
			tools: shown.map((t) => ({
				name: t.name,
				calls: t.calls,
				results: t.results,
				errors: t.errors,
				errorRate: t.results ? t.errors / t.results : 0,
				recoveredErrors: t.recoveredErrors,
				recoveryRate: t.errors ? t.recoveredErrors / t.errors : 0,
				latencyMs: lat(t.latencies),
			})),
		},
		null,
		2,
	);
}

// --- arg helpers -------------------------------------------------------------

/** Read a `--flag <value>` (or `--flag=<value>`) from a raw argv slice. */
function takeFlag(rest: string[], name: string): string | undefined {
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === name) return rest[i + 1];
		if (a?.startsWith(name + "=")) return a.slice(name.length + 1);
	}
	return undefined;
}

/** True if a boolean `--flag` is present in a raw argv slice. */
function hasFlag(rest: string[], name: string): boolean {
	return rest.some((a) => a === name || a.startsWith(name + "="));
}

/**
 * Parse a --since / --until boundary.
 *   "2026-06-01"        → that date, 00:00:00 (since) / 23:59:59 (until) local
 *   full ISO / epoch    → used verbatim
 * Returns epoch ms or undefined if absent/invalid (invalid → throws).
 */
function parseBoundary(raw: string | undefined, edge: "start" | "end"): number | undefined {
	if (!raw) return undefined;
	const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
	if (isoDate) {
		const day = edge === "start" ? `${raw}T00:00:00` : `${raw}T23:59:59.999`;
		const ms = Date.parse(day);
		if (Number.isNaN(ms)) throw new Error(`Invalid date: ${raw} (expected YYYY-MM-DD)`);
		return ms;
	}
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${raw} (expected YYYY-MM-DD or ISO)`);
	return ms;
}

// --- file discovery ----------------------------------------------------------

/** Recursively collect *.jsonl paths under `dir` (empty if absent). */
export function listSessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string): void => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && p.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/** Resolve the sessions dir: $PI_CODING_AGENT_DIR/sessions → ~/.pi/agent/sessions. */
export function resolveSessionsDir(env: Record<string, string | undefined>): string {
	return join(resolveAgentDir(env), "sessions");
}

// --- command wiring ----------------------------------------------------------

export const toolsMetricsCommand = {
	name: "tools-metrics",
	summary: "meta: per-tool usage metrics from s2-agent session logs (calls, errors, latency)",
	details: `Usage:
  s2-agent cli tools-metrics [options]

Scans ~/.pi/agent/sessions/**/*.jsonl (the transcripts s2-agent writes each
run) and reports per-tool metrics: call count, matched results, errors +
error rate, and latency p50/p95/max (wall-clock gap between a toolCall and its
matching toolResult, paired by id within each session).

Filters:
  --since <date>     Only sessions starting on/after (YYYY-MM-DD or ISO)
  --until <date>     Only sessions starting on/before (YYYY-MM-DD or ISO)
  --cwd <substr>     Only sessions whose cwd contains <substr> (case-insensitive)
  --tool <name>      Only rows whose tool name contains <name> (repeatable / csv)

Output:
  --top <n>          Show at most <n> tools (default: all, sorted by calls desc)
  --details          Add p95 / max / mean latency columns
  --json             Emit a single JSON object to stdout
  --sessions-dir <p> Override the sessions root (default: ~/.pi/agent/sessions)

Schema-cost mode (estimates per-request API schema token cost, NO session scan):
  --schema-cost      Rank every registered tool by estimated schema tokens
                     (description + TypeBox params JSON). Built-ins via the SDK
                     factory + extensions via a capturing mock API (no agent boot).
                     With --json, emits the full ranked baseline as JSON.
  --ext <paths>      Override the extension entry points (csv of .ts paths)

Examples:
  s2-agent cli tools-metrics
  s2-agent cli tools-metrics --since 2026-07-01 --details
  s2-agent cli tools-metrics --cwd video_generation__pi --tool bash,edit
  s2-agent cli tools-metrics --json --top 20 > metrics.json
  s2-agent cli tools-metrics --schema-cost
  s2-agent cli tools-metrics --schema-cost --json > schema-cost-baseline.json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const rest = parsed.rest;

		// --- schema-cost mode (no session scan) ---
		if (hasFlag(rest, "--schema-cost")) {
			const extRaw = takeFlag(rest, "--ext");
			const entries = extRaw
				? extRaw.split(",").map((s) => s.trim()).filter(Boolean).map((p) => {
					const source = p.replace(/\.ts$/, "").split("/").pop() ?? p;
					return { source, path: p };
				  })
				: undefined;
			const report = await buildSchemaCostReport(undefined, entries);
			if (parsed.json || parsed.mode === "json") {
				console.log(formatSchemaCostJson(report));
			} else {
				for (const line of formatSchemaCostReport(report)) console.log(line);
			}
			return;
		}

		const since = parseBoundary(takeFlag(rest, "--since"), "start");
		const until = parseBoundary(takeFlag(rest, "--until"), "end");
		const cwdSubstr = takeFlag(rest, "--cwd");
		const toolRaw = takeFlag(rest, "--tool");
		const toolFilter = toolRaw
			? toolRaw.split(",").map((s) => s.trim()).filter(Boolean)
			: [];
		const topRaw = takeFlag(rest, "--top");
		const top = topRaw !== undefined ? parseTop(topRaw) : undefined;
		const details = hasFlag(rest, "--details") || parsed.verbose >= 1;
		const sessionsDir =
			takeFlag(rest, "--sessions-dir") ?? resolveSessionsDir(process.env);

		const files = listSessionFiles(sessionsDir);
		const scans: SessionScan[] = [];
		for (const f of files) {
			let text: string;
			try {
				text = readFileSync(f, "utf8");
			} catch {
				continue;
			}
			scans.push(parseSessionLines(text.split("\n")));
		}

		const report = computeMetrics(scans, { sinceMs: since, untilMs: until, cwdSubstr });
		const opts: FormatOpts = { details, top, toolFilter };

		if (parsed.json || parsed.mode === "json") {
			console.log(formatJson(report, opts));
		} else {
			for (const line of formatReport(report, opts)) console.log(line);
		}
	},
};

/** Parse --top: positive integer. */
function parseTop(raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`Invalid --top "${raw}" — expected a positive integer (e.g. 20).`);
	}
	return n;
}
