/**
 * format.ts — shared terminal-output helpers for the cli commands (effort
 * 2026-08-24-s2-agent-simplify ticket 03).
 *
 * ONE `printTable` (was duplicated in dispatch.ts and tools-metrics.ts — the
 * tools-metrics copy right-aligned numeric columns, kept here as an option)
 * and ONE snippet-clip helper (was duplicated in sessions.ts and memory.ts
 * with only the radius differing).
 *
 * Stays inside the cli namespace (cli/ never enters the cli-sh cjs bundle —
 * map D6); node-free pure string formatting only.
 */

export interface TableColumn {
	/** Row key to read the cell from. */
	key: string;
	/** Header cell text; defaults to `key` (tools-metrics style). */
	label?: string;
}

export interface TableOptions {
	/** Column keys rendered right-aligned (tools-metrics numeric columns). */
	rightAlign?: ReadonlySet<string>;
	/** Line sink; defaults to `console.log` (dispatch style). */
	emit?: (line: string) => void;
}

/**
 * Print `rows` as an aligned column table with a header derived from `cols`.
 * Widths are the max of header label and every cell; cells padEnd, columns
 * join with two spaces, rows trimEnd — byte-identical to both prior copies.
 */
export function printTable(
	rows: Record<string, string>[],
	cols: TableColumn[],
	opts: TableOptions = {},
): void {
	if (rows.length === 0) return;
	const emit = opts.emit ?? ((line: string) => console.log(line));
	const right = opts.rightAlign;
	const widths = cols.map(
		(c) => Math.max((c.label ?? c.key).length, ...rows.map((r) => String(r[c.key] ?? "").length)),
	);
	const fmt = (r: Record<string, string>) =>
		cols
			.map((c, i) => {
				const v = String(r[c.key] ?? "");
				const w = widths[i]!;
				return right?.has(c.key) ? v.padStart(w) : v.padEnd(w);
			})
			.join("  ")
			.trimEnd();
	const header = Object.fromEntries(cols.map((c) => [c.key, c.label ?? c.key])) as Record<
		string,
		string
	>;
	emit(fmt(header));
	for (const r of rows) emit(fmt(r));
}

/**
 * Clip `text` to a window of ±`radius` around a match of length `matchLen` at
 * `idx`, ellipsizing either side that was actually cut, with whitespace
 * collapsed to single spaces (sessions.ts snippets: radius 80; memory.ts
 * entries: radius 120).
 */
export function clipSnippet(text: string, idx: number, matchLen: number, radius = 80): string {
	const start = Math.max(0, idx - radius);
	const end = Math.min(text.length, idx + matchLen + radius);
	return (
		(start > 0 ? "…" : "") +
		text.slice(start, end).replace(/\s+/g, " ").trim() +
		(end < text.length ? "…" : "")
	);
}

/**
 * Truncate `s` to at most `max` chars, appending "…" when cut (round-2
 * ticket 06: dispatch's listTools clip and task-runner's trunc were the same
 * helper modulo one detail — dispatch feeds it whitespace-normalized text and
 * wants a trailing-space-free cut (`trimTail: true`); task-runner truncates
 * quoted/JSON values where every char is content and keeps the raw cut).
 * clipSnippet above is a different beast — a match-window snippet, not a
 * length cap.
 */
export function clip(s: string, max: number, trimTail = false): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max - 1);
	return (trimTail ? cut.trimEnd() : cut) + "…";
}
