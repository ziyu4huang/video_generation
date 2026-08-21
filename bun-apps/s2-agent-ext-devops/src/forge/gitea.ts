/**
 * forge/gitea.ts — Gitea/Forgejo adapter SKELETON (not implemented).
 *
 * select.ts refuses Gitea-looking hosts with a pointer here. This file is the
 * capability map a future implementation must honor — researched against the
 * Gitea REST API (docs.gitea.com/api) and cross-checked with how Renovate's
 * gitea platform handles the same seams. Nothing in it runs today.
 *
 * CAPABILITY MAP (Gitea vs the GitHub adapters in this package)
 * ────────────────────────────────────────────────────────────
 * - Auth: `Authorization: token <PAT>` (max version compat; `Bearer` works on
 *   newer Gitea). PAT via GITEA_TOKEN env — no gh-equivalent CLI to harvest.
 * - Coordinates: `git remote get-url origin` → `https://<host>/api/v1` base.
 * - prStatus:
 *   · GET /repos/{owner}/{repo}/pulls/{index} — `merged` boolean + `merged_at`
 *     (state: open/closed/all), `base.name` / `head.name` / `head.sha`.
 *   · NO mergeable_state equivalent: Gitea exposes a boolean `mergeable`
 *     (nullable while computing → UNKNOWN, same re-GET-then-settle contract as
 *     github-rest.ts). There is NO GitHub-style CLEAN/BEHIND/DIRTY ladder —
 *     divergence must be derived (behind = base has commits head lacks; dirty =
 *     merge conflicts), or reported as UNKNOWN and let local gates decide.
 *   · checks: NO check-runs API. Actions/Woodpecker results surface as COMMIT
 *     STATUSES — GET /repos/{o}/{r}/commits/{ref}/statuses (+ /status for the
 *     combined state). mapChecksRollup's statuses half applies as-is.
 * - mergeNow: POST /repos/{o}/{r}/pulls/{index}/merge with body `{Do: …}` —
 *   merge style enum differs: merge | rebase | rebase-merge | squash |
 *   fast-forward-only (SUPERSET of GitHub; `rebase-merge` ↔ our "rebase").
 *   Available styles are gated by repo settings — probe before offering.
 * - deleteBranch: DELETE /repos/{o}/{r}/branches/{name} (ref shape differs
 *   from GitHub's /git/refs/heads/{name}).
 * - PR drafts: NOT a flag — WIP title prefixes (`WIP:` / `[WIP]`, repo
 *   configurable). Do not treat a draft-PR concept as portable.
 * - Labels on PRs: PUT replaces the whole array (GitHub has add/remove) —
 *   model set-semantics if/when label ops join ForgeClient.
 * - PR body length: ~1MB vs GitHub's ~58k — irrelevant today, relevant when
 *   PR creation joins the interface.
 *
 * When implementing: mirror github-rest.ts's structure (pure mappers
 * mapPullRequest/mapChecksRollup + thin client), reuse rest.ts (override the
 * auth header per the token scheme above), and keep the same error contract
 * (body text embedded in thrown errors).
 */
import type { ForgeClient } from "./types.js";

export const GITEA_ADAPTER_STATUS = "not-implemented" as const;

/** Placeholder constructor: refuses clearly instead of silently mis-calling
 *  the GitHub API against a Gitea host. */
export function createGiteaClient(): ForgeClient {
	throw new Error(
		"Gitea/Forgejo adapter is not implemented yet — see src/forge/gitea.ts for the researched capability map before building it.",
	);
}
