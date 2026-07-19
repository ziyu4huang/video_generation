/**
 * ext-hash — pure functions for computing an extension's warm-deploy cache key.
 * Extracted from build-extensions.ts so the hashing logic (including transitive
 * @repo/* workspace dependency coverage) is independently testable without
 * executing the rest of the build script.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SOURCE_GLOBS = /\.(ts|mts|cts|js|mjs|cjs|json)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__"]);

/** Every source file under `dir` (recursive), as [relativePath, content]. */
export function collectPackageSources(dir: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (!existsSync(dir)) return out;
	const walk = (cur: string) => {
		let entries: string[];
		try {
			entries = readdirSync(cur);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(cur, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				walk(full);
			} else if (st.isFile() && SOURCE_GLOBS.test(name) && !/\.d\.ts$|\.test\.[jt]s$/.test(name)) {
				try {
					out.push([full.slice(dir.length), readFileSync(full, "utf8")]);
				} catch {
					/* unreadable — skip */
				}
			}
		}
	};
	walk(dir);
	return out;
}

/**
 * Every `@repo/*` workspace package dir reachable (transitively) from
 * `pkgDir`'s package.json `dependencies`/`devDependencies`/`peerDependencies`.
 * `workspaceRoot` is the dir each `@repo/<name>` maps to (`<workspaceRoot>/<name>`).
 * Cycle-safe via the shared `visited` set.
 */
export function collectWorkspaceDepDirs(
	pkgDir: string,
	workspaceRoot: string,
	visited: Set<string> = new Set(),
): string[] {
	if (visited.has(pkgDir)) return [];
	visited.add(pkgDir);
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return [];
	let pkgJson: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	try {
		pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
	} catch {
		return [];
	}
	const deps = {
		...pkgJson.dependencies,
		...pkgJson.devDependencies,
		...pkgJson.peerDependencies,
	};
	const out: string[] = [];
	for (const dep of Object.keys(deps)) {
		if (!dep.startsWith("@repo/")) continue;
		const depDir = join(workspaceRoot, dep.slice("@repo/".length));
		if (visited.has(depDir) || !existsSync(depDir)) continue;
		out.push(depDir);
		out.push(...collectWorkspaceDepDirs(depDir, workspaceRoot, visited));
	}
	return out;
}

/** Hash the inputs that determine an ext bundle's output. Stable across runs;
 *  includes every transitive `@repo/*` workspace dependency's source tree, so
 *  a shared-package change invalidates every extension that consumes it. */
export function hashExtInputs(opts: {
	entry: string;
	pkgDir: string;
	thin: boolean;
	workspaceRoot: string;
	minifyCfg: string;
	thinExternals: readonly string[];
	bunVersion: string;
}): string {
	const h = createHash("sha256");
	h.update(`thin=${opts.thin}\n`);
	h.update(`minify=${opts.minifyCfg}\n`);
	h.update(`bun=${opts.bunVersion}\n`);
	if (opts.thin) h.update(`externals=${opts.thinExternals.join(",")}\n`);
	// entry is inside pkgDir, so it's covered by the tree walk; pin pkgDir identity.
	h.update(`pkgDir=${opts.pkgDir}\n`);

	const depDirs = collectWorkspaceDepDirs(opts.pkgDir, opts.workspaceRoot);
	const allDirs = [opts.pkgDir, ...depDirs].sort();
	for (const dir of allDirs) {
		const sources = collectPackageSources(dir).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [rel, content] of sources) {
			h.update(`${dir}:${rel}\n${content}\n`);
		}
	}
	return h.digest("hex").slice(0, 16);
}
