/**
 * forge/github-rest.ts — GitHub REST adapter (the REST-first backend).
 *
 * Implements ForgeClient against api.github.com (or a GHES `…/api/v3` base)
 * with hand-rolled fetch — no Octokit dependency, mirroring the repo's
 * thin-client conventions. All payload mapping lives in PURE exported
 * functions (mapPullRequest / mapChecksRollup) so tests cover the mapping
 * without touching the network; only createGithubRestClient is I/O.
 *
 * Mapping notes (GitHub REST ↔ the gh-CLI shapes the parsers used to see):
 * - state: gh gave `OPEN|MERGED|CLOSED` directly; REST gives `state` +
 *   `merged_at` — "closed" + merged_at ⇒ MERGED, else CLOSED.
 * - mergeState: gh gave `mergeStateStatus`; REST gives `mergeable_state`
 *   (clean/unstable/blocked/behind/dirty/has_hooks/unknown). `mergeable:
 *   null` means GitHub is still computing — ONE internal re-GET after a short
 *   wait before reporting UNKNOWN (the merge CLI's settlePrStatus loop then
 *   handles the remainder; the re-GET just avoids a pointless immediate
 *   UNKNOWN round-trip).
 * - checks: gh gave `pr checks` rows; REST has TWO surfaces — check-runs
 *   (Actions) and commit statuses (any reporter). A true rollup unions both.
 *   Pending is classified by the check-run `status` field (queued/
 *   in_progress), NOT by the absence of a conclusion-in-time — same
 *   re-triggered-check lesson parseChecks documents.
 * - merge: `PUT /pulls/{n}/merge` with `merge_method`; 200 IS the merge (the
 *   gh-CLI contract "success is the confirmation" carries over). Failures
 *   throw ForgeHttpError with the body text embedded (isMissingWorkflowScope
 *   greps it).
 * - deleteBranch: one flag on gh, TWO calls on REST (merge, then DELETE the
 *   head ref). Only runMergeRecipe's opt ever passes true.
 */
import type { PrSnapshot, ForgeClient, MergeStrategy } from "./types.js";
import type { PrState, MergeState, CheckTally } from "../pr-logic.js";
import { createRestTransport, type FetchFn, type RestTransport } from "./rest.js";

const MERGE_STATE_BY_RAW: Record<string, MergeState> = {
	clean: "CLEAN",
	unstable: "UNSTABLE",
	blocked: "BLOCKED",
	behind: "BEHIND",
	dirty: "DIRTY",
	has_hooks: "HAS_HOOKS",
	unknown: "UNKNOWN",
};

const VALID_STATES = new Set<PrState>(["OPEN", "MERGED", "CLOSED"]);

/** How long to wait before the one mergeable-recompute re-GET (GitHub computes
 *  mergeability asynchronously; a short beat usually resolves it first try). */
const MERGEABLE_RETRY_MS = 1500;

/** Pure: map a `GET /repos/{o}/{r}/pulls/{n}` payload onto the PrSnapshot
 *  core (checks filled separately). Defensive like parsePrView — garbage →
 *  OPEN/UNKNOWN + empty refs, never throws. `mergeable` is injected for
 *  testability of the null-retry decision (null ⇒ UNKNOWN pending recompute). */
export function mapPullRequest(raw: unknown): {
	state: PrState;
	mergeState: MergeState;
	mergeSha?: string;
	baseRefName: string;
	headRefName: string;
	headRefOid?: string;
} {
	const r = (raw ?? {}) as Record<string, unknown>;
	const baseRefName = typeof r.base === "object" && r.base !== null && typeof (r.base as { ref?: unknown }).ref === "string"
		? (r.base as { ref: string }).ref
		: "";
	const head = (r.head ?? {}) as { ref?: unknown; sha?: unknown };
	const headRefName = typeof head.ref === "string" ? head.ref : "";
	const headRefOid = typeof head.sha === "string" && head.sha ? head.sha : undefined;
	const state: PrState =
		r.state === "open" ? "OPEN" : r.state === "closed" && r.merged_at ? "MERGED" : r.state === "closed" ? "CLOSED" : "OPEN";
	const mergeableState = typeof r.mergeable_state === "string" ? (MERGE_STATE_BY_RAW[r.mergeable_state] ?? "UNKNOWN") : "UNKNOWN";
	// mergeable === null ⇒ GitHub still computing ⇒ UNKNOWN (never guess CLEAN).
	const mergeState = r.mergeable === null ? "UNKNOWN" : mergeableState;
	const mergeSha = typeof r.merge_commit_sha === "string" && r.merge_commit_sha ? r.merge_commit_sha : undefined;
	return {
		state: VALID_STATES.has(state) ? state : "OPEN",
		mergeState,
		mergeSha,
		baseRefName,
		headRefName,
		headRefOid,
	};
}

/** Check-run conclusion buckets (REST check-runs API). */
const CHECK_RUN_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const CHECK_RUN_PASS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
/** Commit-status states (statuses API). */
const STATUS_FAIL = new Set(["failure", "error"]);
const STATUS_PASS = new Set(["success"]);

/** Pure: union a check-runs payload (`GET /commits/{sha}/check-runs`) and a
 *  combined-statuses payload (`GET /commits/{sha}/status`) into one tally.
 *  Pending is decided by the check-run STATUS field, never by timestamps —
 *  a re-triggered check has no conclusion yet while its old run did. */
export function mapChecksRollup(checkRunsRaw: unknown, statusesRaw: unknown): CheckTally {
	let pass = 0;
	let fail = 0;
	let pending = 0;

	const runs = (checkRunsRaw as { check_runs?: unknown } | null)?.check_runs;
	if (Array.isArray(runs)) {
		for (const run of runs as Array<Record<string, unknown>>) {
			const status = typeof run.status === "string" ? run.status.toLowerCase() : "";
			const conclusion = typeof run.conclusion === "string" ? run.conclusion.toUpperCase() : "";
			if (status === "queued" || status === "in_progress" || status === "waiting" || status === "requested" || (status === "completed" && !conclusion)) {
				pending++;
			} else if (status === "completed" && CHECK_RUN_FAIL.has(conclusion)) fail++;
			else if (status === "completed" && CHECK_RUN_PASS.has(conclusion)) pass++;
			else pending++; // unknown shape — never claim success
		}
	}
	const statuses = (statusesRaw as { statuses?: unknown } | null)?.statuses;
	if (Array.isArray(statuses)) {
		for (const s of statuses as Array<Record<string, unknown>>) {
			const st = typeof s.state === "string" ? s.state.toLowerCase() : "";
			if (STATUS_FAIL.has(st)) fail++;
			else if (STATUS_PASS.has(st)) pass++;
			else pending++; // "pending" + anything unknown
		}
	}
	return { pass, fail, pending };
}

export interface GithubRestOptions {
	owner: string;
	repo: string;
	token: string;
	/** Provenance label for diagnostics (see rest.ts token discipline). */
	tokenKind: string;
	/** Default `https://api.github.com`; GHES installs pass their `…/api/v3`. */
	apiBase?: string;
	fetchFn?: FetchFn;
	/** Injectable sleep for the mergeable re-GET (tests pass 0-ms fakes). */
	sleep?: (ms: number) => Promise<void>;
}

/** Build a ForgeClient backed by the GitHub REST API. */
export function createGithubRestClient(opts: GithubRestOptions): ForgeClient {
	const api = opts.apiBase ?? "https://api.github.com";
	const rest: RestTransport = createRestTransport({ baseUrl: api, token: opts.token, tokenKind: opts.tokenKind, fetchFn: opts.fetchFn });
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const root = `/repos/${opts.owner}/${opts.repo}`;

	async function getPull(n: number): Promise<Record<string, unknown>> {
		return (await rest.request("GET", `${root}/pulls/${n}`)) as Record<string, unknown>;
	}

	return {
		async prStatus(n: number): Promise<PrSnapshot> {
			let data = await getPull(n);
			// mergeable:null ⇒ still computing. One short re-GET; still null ⇒
			// UNKNOWN (settlePrStatus owns further polling).
			if (data.mergeable === null) {
				await sleep(MERGEABLE_RETRY_MS);
				data = await getPull(n);
			}
			const core = mapPullRequest(data);
			let checks: CheckTally = { pass: 0, fail: 0, pending: 0 };
			if (core.headRefOid) {
				// Union BOTH surfaces — check-runs (Actions) and commit statuses.
				const [runs, statuses] = await Promise.all([
					rest.request("GET", `${root}/commits/${core.headRefOid}/check-runs`).catch(() => null),
					rest.request("GET", `${root}/commits/${core.headRefOid}/status`).catch(() => null),
				]);
				checks = mapChecksRollup(runs, statuses);
			}
			return { ...core, checks };
		},

		async mergeNow(n: number, strategy: MergeStrategy, deleteBranch: boolean): Promise<void> {
			await rest.request("PUT", `${root}/pulls/${n}/merge`, { merge_method: strategy });
			if (deleteBranch) {
				// gh's --delete-branch is one op; REST needs the explicit ref delete.
				// 422 = already gone (e.g. auto-delete ran) — tolerate, not an error.
				try {
					const head = await getPull(n);
					const headRef = typeof head.head === "object" && head.head !== null ? (head.head as { ref?: unknown }).ref : undefined;
					if (typeof headRef === "string" && headRef) {
						await rest.request("DELETE", `${root}/git/refs/heads/${headRef}`);
					}
				} catch (err) {
					if (!(err instanceof Error && /HTTP 422/.test(err.message))) throw err;
				}
			}
		},
	};
}
