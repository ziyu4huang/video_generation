/**
 * computeChangedPackages — extension-native TS port of the former
 * scripts/ci-changed-packages.sh. Decides which bun-apps/* packages a CI
 * "tests" matrix needs to actually run, based on which files changed.
 *
 * Algorithm (FAITHFUL 1:1 port — do not "simplify" without re-diffing against
 * the retired bash; the output JSON shape, fail-open semantics, and reverse-BFS
 * are all load-bearing for `gh ship` decisions):
 *
 * 1. Discover every `bun-apps/<pkg>/package.json` (dir name == matrix value).
 * 2. `--all` → every package `true`, done (push-to-main "run everything").
 * 3. `git diff --name-only <baseRef>...<headRef>` (THREE-dot: merge-base) for
 *    the changed file list.
 *    - Empty diff AND `<baseRef>` unresolvable (e.g. shallow clone) → fail OPEN
 *      (every package true): a detection gap must never yield a false-green by
 *      collapsing to an empty package set.
 * 4. Any changed file NOT under a known `bun-apps/<pkg>/` (root config,
 *    .github/, scripts/, submodules, …) → fail OPEN (every package true): a
 *    shared-config change could affect any package and we can't tell which.
 * 5. Otherwise reverse-BFS over the live `@repo/*` graph (read fresh from each
 *    package.json, never a hand-maintained table — so it can't go stale the way
 *    a hardcoded dep map would). A package's affected-set is itself plus every
 *    package that transitively depends on it: if `s2-agent-ext-file2md` changes,
 *    `s2-agent-ext-flux2` (direct dep) AND `s2-agent-ext-movie-director`
 *    (depends on flux2) both re-run.
 *
 * The `@repo/*` edges are read the SAME way the bash did — a textual scan of
 * package.json for `"@repo/<name>"` (matches deps/devDeps/peerDeps/anywhere),
 * NOT a JSON parse — so exotic-but-valid JSON shape differences can't diverge
 * from the retired script. Self-references (`@repo/<self>` devDep/typecheck
 * convention) are stripped, as in the bash.
 *
 * I/O seams (all injectable → fully unit-testable with no real fs/git):
 *  - `spawn`        : `git diff` + `git rev-parse` (standard `git` binary).
 *  - `discoverPackages` : list `bun-apps/*` package dirs (default: real readdir).
 *  - `readDeps`     : a package's `@repo/*` deps (default: textual package.json grep).
 */
import fs from "node:fs";
import path from "node:path";
import type { SpawnFn } from "./spawn.js";

/** Output shape: one boolean per discovered `bun-apps/*` package, sorted by name. */
export type ChangedPackagesMap = Record<string, boolean>;

export interface ComputeChangedPackagesOptions {
	/** Repo root (the `bun-apps/` dir is read from `${repoRoot}/bun-apps`). */
	repoRoot: string;
	/** `--all` mode: every package `true` (no diff run). */
	all?: boolean;
	/** Base ref for `git diff`. Required unless `all` is true. */
	baseRef?: string;
	/** Head ref for `git diff`. Defaults to `"HEAD"`. */
	headRef?: string;
	/** Injectable `git` spawn (diff + rev-parse). Tests inject a fake. */
	spawn: SpawnFn;
	/**
	 * List package dir names under `bun-apps` (sorted). Default: real readdir,
	 * keeping only dirs that contain a `package.json` — mirrors the bash glob over
	 * `$EXTS_DIR/<pkg>/package.json`.
	 */
	discoverPackages?: (extsDir: string) => string[];
	/**
	 * Read a package's `@repo/*` dep dir names (self-reference stripped).
	 * Default: textual scan of `<extsDir>/<pkg>/package.json` for
	 * `"@repo/<name>"`, deduped + sorted — mirrors the bash
	 * `grep -oE '"@repo/[a-zA-Z0-9_-]+"' … | tr -d '"' | sed … | sort -u`.
	 */
	readDeps?: (pkgName: string, extsDir: string) => string[];
}

/**
 * Extract `@repo/<name>` references from raw package.json text, EXACTLY as the
 * retired bash's `grep -oE '"@repo/[a-zA-Z0-9_-]+"'` did (textual, not parsed),
 * then strip quotes + the `@repo/` prefix, drop self, dedupe, and sort.
 */
export function extractRepoDeps(pkgJsonText: string, self: string): string[] {
	const re = /"@repo\/([a-zA-Z0-9_-]+)"/g;
	const names = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(pkgJsonText)) !== null) {
		if (m[1] !== self) names.add(m[1]);
	}
	return [...names].sort();
}

/** Default package discovery: real readdir, dirs with a package.json, sorted. */
export function defaultDiscoverPackages(extsDir: string): string[] {
	if (!fs.existsSync(extsDir)) return [];
	return fs
		.readdirSync(extsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && fs.existsSync(path.join(extsDir, e.name, "package.json")))
		.map((e) => e.name)
		.sort();
}

/** Default deps reader: textual package.json scan (self stripped), like the bash. */
export function defaultReadDeps(pkgName: string, extsDir: string): string[] {
	const file = path.join(extsDir, pkgName, "package.json");
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	return extractRepoDeps(text, pkgName);
}

/**
 * Repo path prefixes that are PROVABLY package-matrix-irrelevant: a change under
 * them cannot affect any bun-apps/<pkg> build or test, so they must NOT trip the
 * rule-4 fail-open (which makes run_local_ci run the FULL 29-package matrix — the
 * ≤5-minute budget's worst amplifier). Each entry says where its coverage
 * actually lives:
 *   .planning/      — docs-only artifacts the standing rule REQUIRES committing
 *                      with every branch/PR; before this list, every PR that
 *                      obeyed the rule ran everything (~12+ min observed).
 *   bun-apps/tests/ — workspace-root gate tests; they execute in the
 *                      regression-gates job (bun run test:dist / test:seam),
 *                      which local_ci runs REGARDLESS of package scoping.
 *   dsh-plugin/sv-analyzer/ — standalone Rust/DSH plugin project under the
 *                      top-level dsh-plugin/ host dir (own cargo build + node
 *                      tests, zero npm deps, not part of the bun workspace);
 *                      it neither imports nor affects any bun-apps/<pkg> build
 *                      or test.
 * Anything else outside bun-apps/<pkg>/ still fails open (shared config,
 * scripts/, .github/, submodules — any of those CAN affect every package).
 */
const MATRIX_IRRELEVANT_PREFIXES = [".planning/", "bun-apps/tests/", "dsh-plugin/sv-analyzer/"];

/**
 * Compute the changed-package map. Always returns a well-formed
 * `Record<string, boolean>` (one entry per discovered package); fail-open cases
 * surface as "all true" rather than throwing. Only a genuine I/O failure (e.g.
 * the `git` binary itself is missing) throws — callers wrap in try/catch to
 * surface a detection error.
 */
export async function computeChangedPackages(
	opts: ComputeChangedPackagesOptions,
): Promise<ChangedPackagesMap> {
	const extsDir = `${opts.repoRoot}/bun-apps`;
	const discover = opts.discoverPackages ?? defaultDiscoverPackages;
	const readDeps = opts.readDeps ?? defaultReadDeps;
	// bash globs `$EXTS_DIR/*/package.json`, and bash glob expansion is always
	// sorted — so the output JSON key order is always alphabetical. Sort here too
	// (an injected `discoverPackages` is not trusted to pre-sort) to keep the
	// emitted key order byte-identical to the retired script.
	const packages = [...discover(extsDir)].sort();

	/** Build an all-true map over the discovered package list (sorted order). */
	const allTrue = (): ChangedPackagesMap =>
		Object.fromEntries(packages.map((p) => [p, true] as const));

	// --- 1. --all: every package true (push-to-main "run everything"). ------
	if (opts.all) return allTrue();

	const baseRef = opts.baseRef;
	if (!baseRef) {
		throw new Error("computeChangedPackages: baseRef is required (or pass all: true)");
	}
	const headRef = opts.headRef ?? "HEAD";

	// --- 2. git diff --name-only (stdout captured even on non-zero exit). ---
	// THREE-dot (`base...head`) = "what THIS branch changed", measured from the
	// merge-base. Two-dot is the symmetric difference against the base's CURRENT
	// tip, so every commit that lands on main after you branch is counted as YOUR
	// change. That is not a rounding error: it silently widens scope, and the
	// moment one of those main-side files sits outside `bun-apps/<pkg>/` the
	// rule-4 fail-open below escalates to the FULL 28-package matrix. Measured
	// 2026-08-15: two-dot reported 17 changed files for a branch that had changed
	// 4. Three-dot is also what GitHub's own PR path-filtering compares, so local
	// and remote agree on what "changed" means.
	const diff = await opts.spawn("git", ["diff", "--name-only", `${baseRef}...${headRef}`], {
		cwd: opts.repoRoot,
	});
	// bash: `git diff … 2>/dev/null || true` — stdout is empty on failure. Mirror
	// by splitting stdout into non-empty lines (exit code is irrelevant here).
	const changedFiles = diff.stdout.split("\n").filter((line) => line !== "");

	// --- 3. Fail-open: empty diff + unresolvable base → every package true. --
	// (e.g. shallow clone missing the base; ci-recipe verifies the base first
	// and throws, so this is a defensive standalone path.)
	if (changedFiles.length === 0) {
		const rev = await opts.spawn("git", ["rev-parse", baseRef], { cwd: opts.repoRoot });
		if (rev.exitCode !== 0) return allTrue();
	}

	// --- 4. Any file outside a known bun-apps/<pkg>/ → fail open (all true). --
	// Matrix-irrelevant prefixes (see MATRIX_IRRELEVANT_PREFIXES) are skipped
	// BEFORE the package match: they neither map to a package nor fail open.
	let runAll = false;
	const directlyTouched = new Set<string>();
	for (const file of changedFiles) {
		if (MATRIX_IRRELEVANT_PREFIXES.some((p) => file.startsWith(p))) continue;
		let matched = false;
		for (const pkg of packages) {
			if (file.startsWith(`bun-apps/${pkg}/`)) {
				directlyTouched.add(pkg);
				matched = true;
				break;
			}
		}
		if (!matched) {
			runAll = true;
		}
	}
	if (runAll) return allTrue();

	// --- 5. Build the live @repo/* dep table + reverse-BFS to dependents. ---
	const depsTable = new Map<string, string[]>();
	for (const pkg of packages) depsTable.set(pkg, readDeps(pkg, extsDir));

	const affected = new Set<string>();
	const queue: string[] = [...directlyTouched];
	while (queue.length > 0) {
		const cur = queue.shift() as string;
		if (affected.has(cur)) continue;
		affected.add(cur);
		// direct dependents of `cur`: every package whose declared deps include it.
		for (const [pkg, deps] of depsTable) {
			if (deps.includes(cur)) queue.push(pkg);
		}
	}

	// --- 6. Emit one boolean per package (sorted order, like the bash glob). -
	const result: ChangedPackagesMap = {};
	for (const pkg of packages) result[pkg] = affected.has(pkg);
	return result;
}
