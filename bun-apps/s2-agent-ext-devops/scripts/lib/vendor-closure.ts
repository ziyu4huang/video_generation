/**
 * vendor-closure.ts — vendor a package AND its dependency closure.
 *
 * `vendorPackage` (ext-build.ts) copies ONE package verbatim, which is only
 * sufficient for self-contained packages (playwright-core, unpdf declare no
 * runtime deps). hyperframes' helper packages need their whole closure shipped
 * beside them: @hyperframes/producer alone pulls puppeteer, 12× @fontsource,
 * hono, linkedom… — if any of those is missing from the deploy tree, the skill
 * that reaches for producer dangles at runtime, and the "fix" the loader would
 * offer (npm install) is exactly what an offline dist must never do.
 *
 * Resolution walks `dependencies` + `optionalDependencies` only:
 *   - peerDependencies are deliberately excluded — a peer is provided by the
 *     CONSUMER (the host or the user's project), same contract as `externals`.
 *   - a hard dep that cannot be resolved is a hard error (half-shipped
 *     closures are silent runtime breakage); an optional dep that cannot be
 *     resolved is pruned — that is what "optional" means.
 *   - optional deps whose `os`/`cpu`/`libc` do not match the deploy target are
 *     pruned (sharp's @img/* platform binaries: only the darwin-arm64 pair
 *     belongs in an Apple-Silicon deploy). Hard deps are never
 *     platform-filtered — an install that satisfies a hard dep for the wrong
 *     platform is broken regardless of what we copy.
 *
 * Every package is resolved from its PARENT's real directory, because the
 * workspace's isolated linker puts a package's dependency set as siblings
 * inside its .bun store dir — reachable only through that exact resolution —
 * and copied with dereference, so no store symlink survives into the deploy
 * tree (the same rule vendorPackage already follows).
 *
 * Copying prunes files that cannot participate in running code — sourcemaps
 * and .d.ts typings. Neither is ever loaded by a runtime; both are pure weight
 * in a dist whose whole point is to be a self-contained tree you copy around.
 * See `isRuntimeDeadFile`.
 *
 * `exclude` (registry `vendorExclude:`) drops closure PACKAGES, not files:
 * deps that are declared by a vendored package but never resolved at runtime.
 * The shipped case is @hyperframes/producer's 11× @fontsource/* (~22MB) —
 * producer serves fonts from a base64 table embedded in its own bundle
 * (fontData.generated.ts) and requires no @fontsource path from disk, so the
 * font packages are pure weight. Exclusions are recorded per node (not
 * conflated with `pruned`) so ext.json can declare them and Gate 5d can honour
 * them as deliberate absences instead of dangling deps.
 */
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// The builtin list is the CORE's (same no-second-copy rule as ext-build.ts).
import { isBuiltinSpecifier } from "../../../s2-agent/src/sh/host-modules.ts";

export interface VendorClosureOptions {
	/** Root package names (no subpaths, no version ranges). */
	roots: string[];
	/** Directory the ROOTS resolve from — the extension's own package dir. */
	resolveFrom: string;
	/** The extension's output dir (…/ext/<name>); packages land in <outDir>/node_modules/. Required only for the copying entry points. */
	outDir?: string;
	/** Platform filter for optional deps. Defaults to the build machine. */
	platform?: NodeJS.Platform;
	/** Architecture filter for optional deps. Defaults to the build machine. */
	arch?: string;
	/**
	 * libc filter for optional deps on linux. Defaults to the build machine
	 * (`detectLibc`). `null` disables the filter — every libc variant ships.
	 */
	libc?: "glibc" | "musl" | null;
	/**
	 * Deps deliberately not shipped (registry `vendorExclude:`), as exact
	 * package names or `<scope>/*` patterns — same shape as `externals`.
	 * A matching dep is neither copied nor traversed, and lands in the
	 * parent node's `excluded` (NOT `pruned`): an exclusion is a decision
	 * the operator made, a prune is one the platform made.
	 */
	exclude?: string[];
}

export interface VendoredNode {
	/** Package name (root name, no subpath). */
	spec: string;
	version: string;
	/** Real (symlink-resolved) source directory in the workspace. */
	srcDir: string;
	/** Optional deps skipped and why ("name" for unresolvable, "name (os/cpu)" for platform). */
	pruned: string[];
	/** Deps dropped by `exclude` — recorded separately so Gate 5d can tell a deliberate absence from a dangling one. */
	excluded: string[];
}

interface ResolvedPkg {
	name: string;
	version: string;
	srcDir: string;
	dependencies: string[];
	optionalDependencies: string[];
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

/**
 * The build machine's libc flavour, for the `libc` package.json field npm and
 * bun use to separate glibc from musl builds of the SAME os/cpu.
 *
 * Without this, a glibc x64 linux deploy also carries every musl artifact —
 * `@img/sharp-libvips-linuxmusl-x64` alone is ~16MB of libvips that can never
 * load on the host that shipped it, and `os`/`cpu` cannot tell the two apart.
 *
 * Detection is the standard one (what `detect-libc` does): a glibc runtime
 * reports its version in the process report header, a musl one does not.
 * `libc` is a linux-only convention, so every other platform returns null and
 * the filter stands down.
 */
export function detectLibc(platform: NodeJS.Platform = process.platform): "glibc" | "musl" | null {
	if (platform !== "linux") return null;
	try {
		const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
		return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
	} catch {
		// No report available: filtering on a guess could drop the ONE artifact
		// the host can load, so ship everything and stay correct-but-fat.
		return null;
	}
}

function readPkg(spec: string, parentDir: string): ResolvedPkg | null {
	// `${spec}/package.json` is the same resolution vendorPackage uses; the
	// package.json subpath is never blocked by `exports`.
	let pkgJsonPath: string;
	try {
		pkgJsonPath = Bun.resolveSync(`${spec}/package.json`, parentDir);
	} catch {
		return null;
	}
	const srcDir = resolve(pkgJsonPath, "..");
	const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		name?: string;
		version?: string;
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
		os?: string[];
		cpu?: string[];
		libc?: string[];
	};
	return {
		name: manifest.name ?? spec,
		version: manifest.version ?? "0.0.0",
		srcDir,
		dependencies: Object.keys(manifest.dependencies ?? {}),
		optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}),
		os: manifest.os,
		cpu: manifest.cpu,
		libc: manifest.libc,
	};
}

/**
 * `os`/`cpu` match per the package.json platform convention: a plain entry
 * must match, a `"!entry"` must not match, and an empty/absent list matches
 * everything.
 */
function platformMatches(values: string[] | undefined, actual: string): boolean {
	if (!values || values.length === 0) return true;
	for (const v of values) {
		if (v.startsWith("!") && v.slice(1) === actual) return false;
	}
	return values.some((v) => !v.startsWith("!") && v === actual);
}

/**
 * Does the package name match an exclude entry? Same semantics as
 * matchesAllowed in ext-build.ts: exact, or `<prefix>/*` for every package
 * under a scope (`@fontsource/*` → `@fontsource/inter`, `@fontsource/…`).
 * Dep names in a package.json are always package roots, never subpaths.
 */
export function matchesExclusion(pkg: string, exclude: readonly string[]): boolean {
	for (const entry of exclude) {
		if (entry === pkg) return true;
		if (entry.endsWith("/*") && pkg.startsWith(entry.slice(0, -1))) return true;
	}
	return false;
}

/** Resolve the full vendoring closure without copying anything. */
export function collectVendorClosure(opts: VendorClosureOptions): VendoredNode[] {
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	// `undefined` means "not specified" → detect; an explicit `null` disables.
	const libc = opts.libc !== undefined ? opts.libc : detectLibc(platform);
	const exclude = opts.exclude ?? [];

	// Excluding a ROOT is a registry contradiction — the entry asks to ship a
	// package and drop it at once — and unlike an excluded DEP it would be
	// silently dropped by Gate 5c's "vendored roots must ship" check only at
	// deploy time. Fail at the shape's authority instead.
	for (const root of opts.roots) {
		if (matchesExclusion(root, exclude)) {
			throw new Error(`vendorClosure: root "${root}" is also in exclude — remove it from vendor or vendorExclude`);
		}
	}

	const nodes: VendoredNode[] = [];
	const visited = new Set<string>();
	// Pending [name, resolve-from-dir] pairs; roots resolve from the ext package,
	// every other dep from its parent package's own directory.
	const work: Array<[string, string]> = opts.roots.map((spec) => [spec, opts.resolveFrom]);

	while (work.length > 0) {
		const [spec, fromDir] = work.shift()!;
		if (isBuiltinSpecifier(spec)) continue;
		if (visited.has(spec)) continue;
		visited.add(spec);

		const pkg = readPkg(spec, fromDir);
		if (!pkg) throw new Error(`vendorClosure: cannot resolve "${spec}" from ${fromDir} — run \`bun install\` in bun-apps/`);

		const pruned: string[] = [];
		const excluded: string[] = [];
		for (const dep of pkg.dependencies) {
			if (isBuiltinSpecifier(dep)) continue;
			if (matchesExclusion(dep, exclude)) {
				excluded.push(dep);
				continue;
			}
			work.push([dep, pkg.srcDir]);
		}
		for (const dep of pkg.optionalDependencies) {
			if (isBuiltinSpecifier(dep)) continue;
			if (matchesExclusion(dep, exclude)) {
				excluded.push(dep);
				continue;
			}
			const depPkg = readPkg(dep, pkg.srcDir);
			if (!depPkg) {
				pruned.push(dep);
				continue;
			}
			if (!platformMatches(depPkg.os, platform) || !platformMatches(depPkg.cpu, arch)) {
				pruned.push(dep);
				continue;
			}
			if (libc !== null && !platformMatches(depPkg.libc, libc)) {
				pruned.push(dep);
				continue;
			}
			work.push([dep, pkg.srcDir]);
		}

		nodes.push({ spec: pkg.name, version: pkg.version, srcDir: pkg.srcDir, pruned, excluded });
	}
	return nodes;
}

/**
 * Copy the package VERBATIM into <outDir>/node_modules/<pkg>/, dereferencing
 * the workspace's store symlinks — same semantics as vendorPackage, split out
 * so the closure walker can copy from an already-resolved srcDir.
 */
export function copyPackageVerbatim(spec: string, srcDir: string, outDir: string): string {
	const destDir = join(outDir, "node_modules", spec);
	mkdirSync(resolve(destDir, ".."), { recursive: true });
	cpSync(srcDir, destDir, { recursive: true, dereference: true, filter: (src) => !isRuntimeDeadFile(src) });
	return destDir;
}

/** Sourcemaps: `.js.map` and every sibling extension tsc/bundlers emit. */
const SOURCEMAP_RE = /\.(?:[cm]?js|[cm]?ts|css)\.map$/;
/** TypeScript declaration files: `.d.ts`, `.d.mts`, `.d.cts`. */
const TYPINGS_RE = /\.d\.[cm]?ts$/;

/**
 * Is this file incapable of participating in running code?
 *
 * A vendored package is shipped to be EXECUTED, not developed against, and two
 * categories in a typical npm tarball can never execute:
 *
 *   - sourcemaps — consulted only by a debugger or a stack-trace prettifier
 *     attached to this process. Absent one, a runtime silently ignores the
 *     `//# sourceMappingURL` comment; nothing throws. In this tree they were
 *     the single largest line item at ~62MB, over a quarter of ext/, led by
 *     three @hyperframes/producer maps at ~16MB each.
 *   - .d.ts typings — erased before anything runs; no loader ever reads them.
 *     ~11MB here.
 *
 * Deliberately NOT pruned: READMEs and LICENSE files. Redistributing a
 * dependency's license text is an obligation, not weight to optimize away, and
 * the whole doc category is ~1MB — the wrong trade in both directions.
 */
export function isRuntimeDeadFile(path: string): boolean {
	return SOURCEMAP_RE.test(path) || TYPINGS_RE.test(path);
}

/** Resolve the closure and copy every node into <outDir>/node_modules/. */
export function vendorClosure(opts: VendorClosureOptions & { outDir: string }): VendoredNode[] {
	const nodes = collectVendorClosure(opts);
	for (const node of nodes) copyPackageVerbatim(node.spec, node.srcDir, opts.outDir);
	return nodes;
}
