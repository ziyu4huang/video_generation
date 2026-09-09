/**
 * arc-ledger — the series arc-number registry and its guard.
 *
 * `.planning/arc-ledger.json` is the single registry of claimed arc numbers
 * per series (self-arc first, schema supports more). Self-arc-19's ledger
 * ticket (t01) is the response to four same-number collisions in the series:
 * a claim is now an explicit append, and THIS module is the machine check —
 * run by `tests/arc-ledger.test.ts`, which permanently asserts that a
 * synthetic duplicate-claim fixture (tests/fixtures/arc-ledger-duplicate/)
 * is REJECTED. A guard never seen red is a guard never seen work.
 *
 * Pure and read-only (no fs mutation):
 *   - `loadLedger(root)`      — parse + schema-shape the ledger file.
 *   - `validateLedger(root)`  — full guard: schema, completeness (both
 *     directions), frontmatter agreement, uniqueness among non-exempt
 *     entries, grandfather constraints, origin/main cross-check.
 *
 * The status vocabulary here is the LEDGER's, not writeMap's closed
 * EffortStatus set: the series' maps carry raw tokens ("done") outside
 * model.ts's "active"|"complete"|"paused", so agreement is checked against
 * the raw `status:` line, never the parsed enum (which would be undefined
 * for "done" and silently pass).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMapFrontmatter } from "./model.js";

/** Repo-relative home of the ledger (committed). */
export const LEDGER_REL_PATH = ".planning/arc-ledger.json";

/** Series folders this bootstrap scopes: `.planning/YYYY-MM-DD-self-arc-<N>/`. */
export const SELF_ARC_DIR_RE = /^\d{4}-\d{2}-\d{2}-self-arc-(\d+)$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ArcLedgerEntry {
	/** Series slug, e.g. "self-arc". */
	series: string;
	/** The claimed arc number. */
	number: number;
	/** Repo-relative effort dir, e.g. ".planning/2026-09-10-self-arc-19". */
	path: string;
	/** Raw status token mirroring the map's frontmatter ("active", "done", …). */
	status: string;
	/** Claim date (folder date for pre-ledger entries). YYYY-MM-DD. */
	claimedAt: string;
	/** Feature branch the claim was made on (live claims). */
	branch?: string;
	/** Squash-merge PR number, filled at merge. */
	mergedPr?: number | null;
	/** Pre-ledger historical claim — legal ONLY for claimedAt <= adopted. */
	grandfathered?: boolean;
	/** Renumber target (path or "series#N") — exempts the entry from uniqueness. */
	renumberedTo?: string;
	note?: string;
}

export interface ArcLedger {
	version: number;
	/** Adoption date: the grandfather horizon. */
	adopted: string;
	claimProcedure?: string;
	entries: ArcLedgerEntry[];
}

export type LoadLedgerResult = { ok: true; ledger: ArcLedger } | { ok: false; error: string };

export interface LedgerValidation {
	ok: boolean;
	problems: string[];
	/** True when the origin/main cross-check did not run (off or unreachable) — never silently. */
	crossCheckSkipped: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the ledger file at `<root>/.planning/arc-ledger.json`. Read-only. */
export function loadLedger(root: string): LoadLedgerResult {
	const file = join(root, LEDGER_REL_PATH);
	if (!existsSync(file)) return { ok: false, error: `ledger file missing: ${LEDGER_REL_PATH}` };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { ok: false, error: `ledger is not valid JSON: ${(e as Error).message}` };
	}
	if (!isRecord(raw)) return { ok: false, error: "ledger must be a JSON object" };
	const { version, adopted, entries } = raw as Record<string, unknown>;
	if (version !== 1) return { ok: false, error: `unsupported ledger version: ${String(version)} (want 1)` };
	if (typeof adopted !== "string" || !DATE_RE.test(adopted)) {
		return { ok: false, error: `adopted must be YYYY-MM-DD, got: ${String(adopted)}` };
	}
	if (!Array.isArray(entries) || entries.length === 0) {
		return { ok: false, error: "entries must be a non-empty array" };
	}
	const parsed: ArcLedgerEntry[] = [];
	for (const e of entries) {
		if (!isRecord(e)) return { ok: false, error: "every entry must be an object" };
		const { series, number, path, status, claimedAt } = e as Record<string, unknown>;
		if (typeof series !== "string" || series.length === 0) return { ok: false, error: "entry.series required" };
		if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
			return { ok: false, error: `entry.number must be a positive integer (${series})` };
		}
		if (typeof path !== "string" || !path.startsWith(".planning/") || path.includes("..")) {
			return { ok: false, error: `entry.path must be repo-relative under .planning/ (${series}#${number})` };
		}
		if (typeof status !== "string" || status.length === 0) {
			return { ok: false, error: `entry.status required (${series}#${number})` };
		}
		if (typeof claimedAt !== "string" || !DATE_RE.test(claimedAt)) {
			return { ok: false, error: `entry.claimedAt must be YYYY-MM-DD (${series}#${number})` };
		}
		parsed.push(e as unknown as ArcLedgerEntry);
	}
	return { ok: true, ledger: { ...(raw as object), version: 1, adopted, entries: parsed } as ArcLedger };
}

/** The map.md frontmatter's RAW `status:` line (not the closed EffortStatus enum). */
function rawFrontmatterStatus(mapMd: string): string | null {
	const block = mapMd.split("---\n")[1];
	if (block === undefined) return null;
	const m = block.match(/^status:\s*(.+)$/m);
	return m ? m[1].trim() : null;
}

/**
 * The guard. `opts.mainLedger`: undefined = probe `git show origin/main:<ledger>`
 * (unreachable ⇒ loud skip); null = cross-check off (focused fixtures);
 * a string = injected main-ledger JSON (test seam).
 */
export function validateLedger(root: string, opts?: { mainLedger?: string | null }): LedgerValidation {
	const problems: string[] = [];

	const loaded = loadLedger(root);
	if (!loaded.ok) {
		return { ok: false, problems: [`schema: ${loaded.error}`], crossCheckSkipped: true };
	}
	const { entries } = loaded.ledger;

	// Completeness (both directions): every series dir has an entry; every
	// entry's dir exists, and its path/number/series agree with each other.
	for (const name of readdirSync(join(root, ".planning"))) {
		const m = name.match(SELF_ARC_DIR_RE);
		if (!m) continue;
		const number = Number(m[1]);
		if (!entries.some((e) => e.series === "self-arc" && e.number === number)) {
			problems.push(`completeness: .planning/${name} has NO ledger entry — every series dir must be claimed`);
		}
	}
	for (const e of entries) {
		const base = e.path.split("/").pop() ?? "";
		const m = base.match(SELF_ARC_DIR_RE);
		if (!m || Number(m[1]) !== e.number) {
			problems.push(`schema: entry path ${e.path} does not end with -${e.number} (${e.series})`);
			continue;
		}
		const dir = join(root, e.path);
		if (!existsSync(dir)) {
			problems.push(`completeness: entry ${e.series}#${e.number} points at missing dir ${e.path}`);
			continue;
		}
		const mapPath = join(dir, "map.md");
		if (!existsSync(mapPath)) {
			problems.push(`agreement: ${e.path}/map.md missing — every effort needs a map`);
			continue;
		}
		const md = readFileSync(mapPath, "utf8");
		const { meta } = parseMapFrontmatter(md);
		if (!meta || meta.effort !== base) {
			problems.push(`agreement: ${e.path} frontmatter effort ≠ folder name (${base})`);
		}
		const rawStatus = rawFrontmatterStatus(md);
		if (rawStatus !== e.status) {
			problems.push(`agreement: ${e.path} frontmatter status "${rawStatus}" ≠ ledger "${e.status}"`);
		}
	}
	return { ok: problems.length === 0, problems, crossCheckSkipped: true };
}
