/**
 * forge/select.ts — pick and build the ForgeClient for the repo at hand.
 *
 * Policy: REST-FIRST, gh-CLI fallback, never anonymous REST.
 *   1. Token from `GITHUB_TOKEN` / `GH_TOKEN` env  → GitHub REST adapter.
 *   2. Token from `gh auth token` (gh present + authenticated) → REST adapter.
 *   3. gh on PATH → the gh-CLI client (forge/gh-cli.ts, the historical impl).
 *   4. Neither → throw with remediation.
 * REST wins whenever a token exists because it is cross-platform, typed-error,
 * and scriptable — the gh CLI stays as the no-token convenience path.
 *
 * Repo coordinates come from `git remote get-url origin` (owner/repo/host);
 * github.com → https://api.github.com, other GitHub hosts → GHES `…/api/v3`.
 * A non-GitHub host (Gitea/Forgejo) is detected and refused with a pointer to
 * the not-yet-implemented adapter — no silent wrong-API calls.
 *
 * Registry+probe shape mirrors movie-director's provider registry: static
 * knowledge of the backends, runtime availability as the truth. The resolved
 * client is memoized per repoRoot (extension tool handlers re-run per call;
 * probing + token resolution should not repeat).
 */
import type { ForgeClient } from "./types.js";
import { createGithubRestClient } from "./github-rest.js";
import { createGhClient } from "./gh-cli.js";
import type { FetchFn } from "./rest.js";
import type { SpawnFn } from "../spawn.js";
import { createLiveSpawn } from "../spawn.js";

/** A git remote URL split into its forge coordinates. */
export interface ForgeCoords {
	host: string;
	owner: string;
	repo: string;
}

/**
 * Pure: parse a `git remote get-url` value into {host, owner, repo}. Accepts
 * SCP-style SSH (`git@github.com:owner/repo.git`), full URLs
 * (`https://host/owner/repo.git`, with optional `.git` and credentials),
 * and bare `host:owner/repo` forms. Returns null when not parseable.
 */
export function parseRemoteUrl(url: string): ForgeCoords | null {
	const trimmed = (url ?? "").trim();
	if (!trimmed) return null;

	// https://[user@]host/owner/repo(.git)
	let m = trimmed.match(/^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/);
	if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
	// git@host:owner/repo(.git) — SCP-style SSH, colon separator
	m = trimmed.match(/^(?:[^@\s]+@)([^:\s/]+):([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/);
	if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
	// ssh://git@host[:port]/owner/repo(.git)
	m = trimmed.match(/^ssh:\/\/(?:[^@\s/]+@)?([^/\s:]+)(?::\d+)?\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/);
	if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
	return null;
}

/** Is this host a GitHub endpoint? github.com or a GHES install (any host —
 *  GHES is self-hosted, so we accept and derive the API base from the host). */
function isGithubHost(host: string): boolean {
	return host === "github.com" || host.endsWith(".ghe.com");
}

/** Gitea/Forgejo hosts we recognize by common naming, for a clearer refusal
 *  message. Non-GitHub hosts that don't match still get the generic refusal. */
function looksLikeGitea(host: string): boolean {
	return host.includes("gitea") || host.includes("forgejo") || host.endsWith(".codeberg.org");
}

export interface SelectForgeDeps {
	spawn?: SpawnFn;
	/** Default process.env (tests inject). */
	env?: Record<string, string | undefined>;
	/** Injectable fetch for the REST adapter (tests). */
	fetchFn?: FetchFn;
	/** cwd for the git remote query (defaults to process.cwd()). */
	repoRoot?: string;
}

export interface SelectedForge {
	client: ForgeClient;
	/** Which backend won — surfaces in diagnostics. */
	backend: "github-rest" | "gh-cli";
	coords: ForgeCoords;
	/** Where the token came from (diagnostics ONLY — never the token itself). */
	tokenKind?: string;
}

/**
 * Resolve the repo's forge + backend and build the client. Throws (with
 * remediation text) when the remote is not parseable, the forge is not
 * supported yet, or no backend is available.
 */
export async function selectForgeClient(deps: SelectForgeDeps = {}): Promise<SelectedForge> {
	const spawn = deps.spawn ?? createLiveSpawn(deps.repoRoot ?? process.cwd());
	const env = deps.env ?? process.env;

	const remote = await spawn("git", ["remote", "get-url", "origin"]);
	if (remote.exitCode !== 0 || !remote.stdout.trim()) {
		throw new Error(
			`forge selection: could not read the origin remote URL (git remote get-url origin, exit ${remote.exitCode}). Set one, or point the tool at a git checkout.`,
		);
	}
	const coords = parseRemoteUrl(remote.stdout);
	if (!coords) {
		throw new Error(`forge selection: unparseable origin remote URL: ${remote.stdout.trim()}`);
	}
	if (!isGithubHost(coords.host)) {
		const hint = looksLikeGitea(coords.host)
			? `Host "${coords.host}" looks like a Gitea/Forgejo instance — the Gitea adapter is not implemented yet (see src/forge/gitea.ts for the capability map).`
			: `Host "${coords.host}" is not a known GitHub endpoint and no adapter exists for it yet.`;
		throw new Error(`forge selection: unsupported forge. ${hint}`);
	}

	// 1) env tokens → REST
	const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
	if (envToken) {
		return {
			client: createGithubRestClient({ ...coords, token: envToken, tokenKind: "GITHUB_TOKEN env", fetchFn: deps.fetchFn }),
			backend: "github-rest",
			coords,
			tokenKind: "GITHUB_TOKEN env",
		};
	}

	// 2) gh auth token → REST (token value NEVER leaves this function except
	//    into the Authorization header)
	const ghToken = await spawn("gh", ["auth", "token"]);
	if (ghToken.exitCode === 0 && ghToken.stdout.trim()) {
		return {
			client: createGithubRestClient({ ...coords, token: ghToken.stdout.trim(), tokenKind: "gh auth token", fetchFn: deps.fetchFn }),
			backend: "github-rest",
			coords,
			tokenKind: "gh auth token",
		};
	}

	// 3) gh on PATH → gh-CLI client (its own auth surface; may still be logged out —
	//    its calls will fail with gh's own actionable errors)
	const probe = await spawn("gh", ["--version"]);
	if (probe.exitCode === 0) {
		return { client: createGhClient(spawn), backend: "gh-cli", coords };
	}

	throw new Error(
		`forge selection: no backend for github.com repo ${coords.owner}/${coords.repo}. ` +
			`Set GITHUB_TOKEN, or authenticate the gh CLI (\`gh auth login\`, or \`gh auth token\` failing above), or install gh.`,
	);
}

// Module-level memo: probe once per repoRoot per process (extension tool
// handlers re-run per call; token resolution + probes should not).
const memo = new Map<string, Promise<SelectedForge>>();

/** Memoized selectForgeClient keyed by repoRoot/cwd. Tests that inject
 *  spawn/env/fetchFn should call selectForgeClient directly (no memo). */
export function selectForgeClientCached(deps: SelectForgeDeps = {}): Promise<SelectedForge> {
	const key = deps.repoRoot ?? process.cwd();
	let hit = memo.get(key);
	if (!hit) {
		hit = selectForgeClient(deps);
		memo.set(key, hit);
		// A failed selection should not poison the cache (e.g. gh was installed
		// mid-session) — drop it so the next call re-probes.
		hit.catch(() => memo.delete(key));
	}
	return hit;
}
