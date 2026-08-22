/**
 * forge/gitea.ts — Gitea/Forgejo adapter (REST backend).
 *
 * Implements ForgeClient against a Gitea/Forgejo instance (`…/api/v1`) with
 * the same thin-client shape as github-rest.ts: all payload mapping lives in
 * PURE exported functions (mapGiteaPullRequest / mapGiteaStatuses /
 * toGiteaMergeStyle) so tests cover the mapping without touching the network;
 * only createGiteaClient is I/O. Auth is `Authorization: token <PAT>` — the
 * headers option in rest.ts merges LAST, fully replacing the Bearer default.
 *
 * Mapping notes (Gitea API v1 ↔ the ForgeClient contract), researched against
 * docs.gitea.com/api and cross-checked with Renovate's gitea platform:
 * - auth: `Authorization: token <PAT>` (max version compat; `Bearer` works on
 *   newer Gitea only). PAT via GITEA_TOKEN env — there is no gh-equivalent
 *   CLI to harvest one from (select.ts aborts with remediation when missing).
 * - coordinates: `git remote get-url <remote>` → `https://<host>/api/v1` base.
 *   GITEA_API_BASE overrides (http instances, non-standard prefixes).
 * - state: `state` + `merged` boolean (+ `merged_at`): open ⇒ OPEN,
 *   closed+merged ⇒ MERGED, closed ⇒ CLOSED.
 * - mergeState: Gitea has NO mergeable_state ladder — just a nullable boolean
 *   `mergeable`. true ⇒ CLEAN, false ⇒ BLOCKED (conflicts OR repo-blocked —
 *   the honest single bucket; errs safe: the merge recipe blocks on
 *   non-CLEAN). null ⇒ still computing ⇒ ONE re-GET after a short wait, then
 *   UNKNOWN (settlePrStatus owns further polling). CONSEQUENCE: the merge
 *   recipe's BEHIND branch is unreachable on Gitea — a behind-but-mergeable
 *   PR reports CLEAN and merges (as a merge/rebase). The local-CI gate, not
 *   mergeState, is the correctness gate, so this is acceptable.
 * - checks: NO check-runs API — Actions/Woodpecker results surface as COMMIT
 *   STATUSES (`GET /repos/{o}/{r}/commits/{ref}/statuses`, a bare array).
 *   success ⇒ pass, failure/error ⇒ fail, everything else ⇒ pending (never
 *   claim success).
 * - merge: `POST /repos/{o}/{r}/pulls/{n}/merge` with `{Do: <style>}`; the
 *   style enum is a SUPERSET of GitHub's — merge | rebase | rebase-merge |
 *   squash | fast-forward-only. Our "rebase" ↔ Gitea's `rebase-merge`
 *   (toGiteaMergeStyle). Available styles are gated by repo settings; a
 *   disabled style 422s with the body text embedded (same grep-able contract
 *   as github-rest).
 * - deleteBranch: `DELETE /repos/{o}/{r}/branches/{name}` (ref shape differs
 *   from GitHub's /git/refs/heads/{name}); 404/422 tolerated (already gone).
 * - mergeSha: Gitea's PR payload exposes no merge-commit SHA ⇒ mergeSha stays
 *   undefined. Consumers already degrade: pr-finish detaches onto
 *   `<remote>/<base>`, verify-merge tolerates a missing sha.
 * - PR drafts are NOT a flag — WIP title prefixes (repo-configurable). Do not
 *   treat a draft-PR concept as portable.
 * - PR body length ~1MB (vs GitHub's ~58k) — irrelevant until PR creation
 *   joins the interface.
 * - prList: `GET /pulls?state=open|closed&limit=50&page=N` — Gitea caps
 *   `limit` at 50/page. state="merged" filters `merged_at` rows client-side
 *   (same as github-rest); 10-page hard cap bounds the tail.
 * - fork PRs may have a null head `ref` — rows without one are skipped.
 */
import type { PrSnapshot, ForgeClient, MergeStrategy, PrListRow } from "./types.js";
import type { PrState, MergeState, CheckTally } from "../pr-logic.js";
import { createRestTransport, ForgeHttpError, type FetchFn, type RestTransport } from "./rest.js";

/** Gitea's merge-style enum (a superset of GitHub's). */
export type GiteaMergeStyle = "merge" | "rebase" | "rebase-merge" | "squash" | "fast-forward-only";

/** Pure: our MergeStrategy (gh-CLI spelling) → Gitea's `Do` parameter. */
export function toGiteaMergeStyle(s: MergeStrategy): GiteaMergeStyle {
	return s === "rebase" ? "rebase-merge" : s;
}

/** How long to wait before the one mergeable-recompute re-GET (Gitea computes
 *  mergeability asynchronously, same as GitHub). */
const MERGEABLE_RETRY_MS = 1500;

/** Gitea caps list endpoints at 50/page (unlike GitHub's 100). */
const PAGE_SIZE = 50;

/** Default API base for a Gitea host (https — TLS-first; SSH remote URLs
 *  carry no scheme, and http instances override via GITEA_API_BASE). */
export function giteaDefaultApiBase(host: string): string {
	return `https://${host}/api/v1`;
}

/** Pure: map a `GET /repos/{o}/{r}/pulls/{n}` payload onto the PrSnapshot
 *  core (checks filled separately). Defensive like mapPullRequest — garbage →
 *  OPEN/UNKNOWN + empty refs, never throws. `mergeable` is injected for
 *  testability of the null-retry decision. */
export function mapGiteaPullRequest(raw: unknown): {
	state: PrState;
	mergeState: MergeState;
	baseRefName: string;
	headRefName: string;
	headRefOid?: string;
} {
	const r = (raw ?? {}) as Record<string, unknown>;
	const base = (r.base ?? {}) as { ref?: unknown };
	const head = (r.head ?? {}) as { ref?: unknown; sha?: unknown };
	const baseRefName = typeof base.ref === "string" ? base.ref : "";
	const headRefName = typeof head.ref === "string" ? head.ref : "";
	const headRefOid = typeof head.sha === "string" && head.sha ? head.sha : undefined;
	const state: PrState = r.state === "open" ? "OPEN" : r.state === "closed" && r.merged === true ? "MERGED" : r.state === "closed" ? "CLOSED" : "OPEN";
	// No ladder on Gitea: boolean mergeable. null ⇒ still computing ⇒ UNKNOWN;
	// false conflates conflicts and repo-blocked ⇒ BLOCKED (errs safe).
	const mergeState: MergeState = r.mergeable === null ? "UNKNOWN" : r.mergeable === true ? "CLEAN" : r.mergeable === false ? "BLOCKED" : "UNKNOWN";
	return { state, mergeState, baseRefName, headRefName, headRefOid };
}

/** Commit-status state buckets (Gitea statuses use GitHub's status strings). */
const GITEA_STATUS_FAIL = new Set(["failure", "error"]);
const GITEA_STATUS_PASS = new Set(["success"]);

/** Pure: map a `GET /repos/{o}/{r}/commits/{ref}/statuses` payload (a BARE
 *  array; `{statuses:[…]}` accepted defensively) into one tally. Anything not
 *  positively pass/fail counts pending — never claim success. */
export function mapGiteaStatuses(raw: unknown): CheckTally {
	let pass = 0;
	let fail = 0;
	let pending = 0;
	const list = Array.isArray(raw) ? raw : (raw as { statuses?: unknown } | null)?.statuses;
	if (Array.isArray(list)) {
		for (const s of list as Array<Record<string, unknown>>) {
			const st = typeof s.status === "string" ? s.status.toLowerCase() : typeof s.state === "string" ? s.state.toLowerCase() : "";
			if (GITEA_STATUS_FAIL.has(st)) fail++;
			else if (GITEA_STATUS_PASS.has(st)) pass++;
			else pending++; // "pending" + anything unknown
		}
	}
	return { pass, fail, pending };
}

export interface GiteaRestOptions {
	host: string;
	owner: string;
	repo: string;
	token: string;
	/** Provenance label for diagnostics (see rest.ts token discipline). */
	tokenKind: string;
	/** Default `https://<host>/api/v1` (giteaDefaultApiBase). */
	apiBase?: string;
	fetchFn?: FetchFn;
	/** Injectable sleep for the mergeable re-GET (tests pass 0-ms fakes). */
	sleep?: (ms: number) => Promise<void>;
}

/** Build a ForgeClient backed by a Gitea/Forgejo instance. */
export function createGiteaClient(opts: GiteaRestOptions): ForgeClient {
	const api = opts.apiBase ?? giteaDefaultApiBase(opts.host);
	// headers merge LAST in rest.ts — the `token` scheme fully replaces the
	// Bearer default; the GitHub version headers are absent for cleanliness.
	const rest: RestTransport = createRestTransport({
		baseUrl: api,
		token: opts.token,
		tokenKind: opts.tokenKind,
		fetchFn: opts.fetchFn,
		headers: { Authorization: `token ${opts.token}`, Accept: "application/json" },
	});
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
			const core = mapGiteaPullRequest(data);
			let checks: CheckTally = { pass: 0, fail: 0, pending: 0 };
			if (core.headRefOid) {
				// Statuses are the ONLY check surface on Gitea (no check-runs API).
				const statuses = await rest.request("GET", `${root}/commits/${core.headRefOid}/statuses`).catch(() => null);
				checks = mapGiteaStatuses(statuses);
			}
			return { ...core, checks };
		},

		async mergeNow(n: number, strategy: MergeStrategy, deleteBranch: boolean): Promise<void> {
			await rest.request("POST", `${root}/pulls/${n}/merge`, { Do: toGiteaMergeStyle(strategy) });
			if (deleteBranch) {
				// DELETE /branches/{name} (not GitHub's /git/refs/heads/{name}).
				// 404/422 = already gone (auto-delete ran) — tolerate, not an error.
				try {
					const head = await getPull(n);
					const headRef = typeof head.head === "object" && head.head !== null ? (head.head as { ref?: unknown }).ref : undefined;
					if (typeof headRef === "string" && headRef) {
						await rest.request("DELETE", `${root}/branches/${headRef}`);
					}
				} catch (err) {
					if (err instanceof ForgeHttpError && (err.status === 404 || err.status === 422)) return;
					throw err;
				}
			}
		},

		async prList(state: "open" | "merged", limit = 200): Promise<PrListRow[]> {
			// Same client-side merged filter as github-rest: list closed PRs,
			// keep merged_at rows. 50/page (Gitea's cap) until `limit` rows or a
			// short page, hard cap of 10 pages.
			const rows: PrListRow[] = [];
			const pageState = state === "open" ? "open" : "closed";
			for (let page = 1; page <= 10 && rows.length < limit; page++) {
				const batch = (await rest.request("GET", `${root}/pulls?state=${pageState}&limit=${PAGE_SIZE}&page=${page}`)) as Array<
					Record<string, unknown>
				>;
				if (!Array.isArray(batch) || batch.length === 0) break;
				for (const p of batch) {
					const mergedAt = typeof p.merged_at === "string" ? p.merged_at : undefined;
					if (state === "merged" && !mergedAt) continue; // closed-but-unmerged
					const head = (p.head ?? {}) as { ref?: unknown };
					const num = typeof p.number === "number" ? p.number : undefined;
					const ref = typeof head.ref === "string" ? head.ref : "";
					if (num !== undefined && ref) rows.push({ number: num, headRefName: ref, mergedAt });
				}
				if (rows.length >= limit || batch.length < PAGE_SIZE) break;
			}
			return rows.slice(0, limit);
		},
	};
}
