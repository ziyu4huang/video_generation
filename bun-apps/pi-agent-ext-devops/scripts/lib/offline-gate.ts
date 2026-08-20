/**
 * offline-gate.ts — Gate 5: the deploy tree is offline-contained.
 *
 * Gates 1–4 (ext-build.ts + verifyDualState in deploy.ts) police the BUNDLE;
 * nothing policed the TREE. Gate 5 closes the three blind spots, each a way a
 * "self-contained" deploy could still reach off itself:
 *
 *   5a. scanSymlinkEscapes — no symlink in the tree may resolve outside it.
 *       A vendoring bug that copies a link instead of dereferencing it points
 *       back at the build machine's ~/.bun store (the isolated linker's link
 *       farm). The stale repo-root dist/pi-agent tree carried a live one.
 *   5b. scanBinaryForeignPaths — the compiled binary may not bake build-machine
 *       paths beyond the documented bun-cache artifacts (Gate 4 scans ext.cjs
 *       only; `bun build --compile` inlines `__dirname`s of its own).
 *   5c. verifyVendoredCompleteness — every `vendored` entry in every ext.json
 *       actually shipped.
 *   5d. verifyVendoredClosure — every vendored package's HARD deps resolve
 *       inside the tree. A dangling dep has no offline remediation: the
 *       skill-loader's answer would be an npm install, which the dist must
 *       never offer.
 *
 * Runs on the staged tree BEFORE rename/freeze/`current` swap, so a violation
 * never becomes the deployed version.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { scanForeignPaths } from "./ext-build.ts";
// The builtin list is the CORE's (same no-second-copy rule as ext-build.ts).
import { isBuiltinSpecifier } from "../../../pi-agent/src/sh/host-modules.ts";

/** Depth-first walk, never following symlinks (a link could escape the tree). */
function walkLstat(dir: string, fn: (p: string) => void): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const p = join(dir, name);
		let st;
		try {
			st = lstatSync(p);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) {
			fn(p); // report the LINK itself, never recurse through it
		} else if (st.isDirectory()) {
			walkLstat(p, fn);
			fn(p);
		} else {
			fn(p);
		}
	}
}

/**
 * 5a. Every symlink whose target resolves outside `root`. Lexical resolution
 * (resolve against the link's dir, no fs access) so dangling escapes are
 * caught too — a dangling link into ~/.bun is still a broken deploy.
 */
export function scanSymlinkEscapes(root: string): string[] {
	const rootAbs = resolve(root);
	const escapes: string[] = [];
	walkLstat(rootAbs, (p) => {
		if (!lstatSync(p).isSymbolicLink()) return;
		const target = readlinkSync(p);
		const resolved = resolve(dirname(p), target);
		if (resolved !== rootAbs && !resolved.startsWith(`${rootAbs}/`)) {
			escapes.push(`${p} -> ${resolved}`);
		}
	});
	return escapes;
}

interface AllowlistEntry {
	prefix: string;
	maxHits: number;
	reason: string;
}

/**
 * Binary-scanned path exceptions. `bun build --compile` bakes the build-time
 * `__dirname` of deps it inlines; the artifact is dead weight in the binary,
 * not a live resolution — but a vendoring defect would produce a BURST of
 * cache paths, so each prefix carries a small hit cap rather than a blanket
 * pass. Prefixes are `~/`-prefixed and expanded at call time (the cache path
 * carries per-machine content hashes, so exact strings never match twice).
 */
const BINARY_PATH_ALLOWLIST: AllowlistEntry[] = [
	{
		prefix: "~/.bun/install/cache/",
		maxHits: 3,
		reason: "bun --compile bakes the build-time __dirname of an inlined dep (photon-node); dead code",
	},
];

export interface BinaryForeignPathsResult {
	/** Home/repo paths that must fail the deploy. */
	foreign: string[];
	/** Allowlisted artifacts, printed as a build warning. */
	allowed: string[];
}

/** 5b. Foreign build-machine paths inside the compiled binary. */
export function scanBinaryForeignPaths(
	binaryPath: string,
	finalTarget: string,
	roots: { home?: string; repo?: string } = {},
): BinaryForeignPathsResult {
	// Invalid bytes decode to U+FFFD — harmless for a path-prefix scan.
	const content = readFileSync(binaryPath, "utf8");
	const foreign = scanForeignPaths(content, finalTarget, roots);
	const home = roots.home ?? homedir();

	const allowed: string[] = [];
	const trulyForeign: string[] = [];
	for (const entry of BINARY_PATH_ALLOWLIST) {
		const prefix = entry.prefix.replace(/^~/, home);
		const hits = foreign.filter((p) => p.startsWith(prefix));
		allowed.push(...hits.slice(0, entry.maxHits));
		trulyForeign.push(...hits.slice(entry.maxHits));
	}
	const matched = new Set(BINARY_PATH_ALLOWLIST.flatMap((e) =>
		foreign.filter((p) => p.startsWith(e.prefix.replace(/^~/, home))),
	));
	trulyForeign.push(...foreign.filter((p) => !matched.has(p)));

	return { foreign: trulyForeign, allowed };
}

interface ExtManifest {
	vendored?: string[];
}

/** 5c. Declared-but-unshipped vendor roots: [{ext, pkg}]. */
export function verifyVendoredCompleteness(root: string): Array<{ ext: string; pkg: string }> {
	const missing: Array<{ ext: string; pkg: string }> = [];
	const extRoot = join(root, "ext");
	if (!existsSync(extRoot)) return missing;
	for (const name of readdirSync(extRoot)) {
		const extDir = join(extRoot, name);
		const manifestPath = join(extDir, "ext.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtManifest;
		for (const pkg of manifest.vendored ?? []) {
			if (!existsSync(join(extDir, "node_modules", pkg, "package.json"))) {
				missing.push({ ext: name, pkg });
			}
		}
	}
	return missing;
}

interface PkgManifest {
	name?: string;
	dependencies?: Record<string, string>;
}

/**
 * Does `dep` resolve for a package at `pkgDir`, walking the node_modules chain
 * up to `root` (the same ancestor walk Node performs at runtime)?
 */
function depResolves(root: string, pkgDir: string, dep: string): boolean {
	for (let dir = pkgDir; ; dir = dirname(dir)) {
		if (basename(dirname(dir)) === "node_modules" || basename(dir) === "node_modules") {
			if (existsSync(join(dir, "..", "node_modules", dep, "package.json"))) return true;
		}
		if (existsSync(join(dir, "node_modules", dep, "package.json"))) return true;
		if (dir === root || dirname(dir) === dir) break;
	}
	return false;
}

/** 5d. Vendored packages whose HARD deps dangle: [{pkg, missing[]}]. */
export function verifyVendoredClosure(root: string): Array<{ pkg: string; missing: string[] }> {
	const rootAbs = resolve(root);
	const violations = new Map<string, string[]>();

	// Every dir named node_modules in the tree, top-level and nested.
	const nodeModulesDirs: string[] = [];
	walkLstat(rootAbs, (p) => {
		if (lstatSync(p).isDirectory() && basename(p) === "node_modules") nodeModulesDirs.push(p);
	});

	for (const nmDir of nodeModulesDirs) {
		for (const entry of readdirSync(nmDir)) {
			if (entry.startsWith(".")) continue;
			const pkgDir = join(nmDir, entry);
			if (!lstatSync(pkgDir).isDirectory()) continue;
			// A scope dir contains packages; audit those.
			const candidates = entry.startsWith("@")
				? readdirSync(pkgDir).map((sub) => join(pkgDir, sub))
				: [pkgDir];
			for (const candidate of candidates) {
				if (!existsSync(join(candidate, "package.json"))) continue;
				const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as PkgManifest;
				const missing = Object.keys(manifest.dependencies ?? {}).filter(
					(dep) => !isBuiltinSpecifier(dep) && !depResolves(rootAbs, candidate, dep),
				);
				if (missing.length > 0) {
					const key = manifest.name ?? candidate;
					violations.set(key, [...(violations.get(key) ?? []), ...missing]);
				}
			}
		}
	}
	return [...violations.entries()].map(([pkg, missing]) => ({ pkg, missing }));
}
