/**
 * core-cache.ts — content-addressed cache for the compiled sh core (Phase 3 §a).
 *
 * <outRoot>/.cores/<hash> holds ONE copy of each distinct core; every version
 * directory hardlinks it as its `pi-agent`. Hashing the core's BUILD INPUTS
 * (not the binary) means a "nothing changed in the core" deploy skips the
 * compile entirely — the measured 15-version tree held 11 distinct binaries,
 * ~280 MB of duplication, and every one of them paid the compile again.
 *
 * Inputs hashed: the pi-agent/src/ tree AS COMPILED (i.e. after the
 * embedded-assets codegen stage, so the generated manifest is covered exactly
 * as the compiler sees it), the resolved @earendil-works/pi-coding-agent
 * version, Bun.version, the entry relpath, and the compile flag set.
 *
 * freeze:false deploys BYPASS the cache (spec Risk 2): hardlinks share an
 * inode, so chmod-ing one copy re-modes every copy — a writable cached core
 * would make every frozen version sharing it writable. A no-freeze deploy
 * therefore compiles a plain, private copy and never touches .cores.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const CORES_DIR = ".cores";

/** Update the hash with one file tree: sorted relpaths + contents. */
function hashTree(hash: ReturnType<typeof createHash>, root: string, prefix: string): void {
	const entries: Array<{ rel: string; abs: string; isDir: boolean }> = [];
	for (const name of readdirSync(root)) {
		const abs = join(root, name);
		const st = statSync(abs);
		entries.push({ rel: join(prefix, name), abs, isDir: st.isDirectory() });
	}
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	for (const e of entries) {
		hash.update(e.rel);
		hash.update("\0");
		if (e.isDir) hashTree(hash, e.abs, e.rel);
		else hash.update(readFileSync(e.abs));
		hash.update("\0");
	}
}

export interface CoreHashInputs {
	/** pi-agent package dir; its src/ tree is hashed as-is (run the codegen first). */
	piAgentDir: string;
	/** Resolved @earendil-works/pi-coding-agent version string. */
	piPkgVersion: string;
	bunVersion: string;
	/** Entry relpath under piAgentDir, e.g. "src/cli-sh.ts". */
	entry: string;
	/** Compile flag markers, e.g. ["--minify"] — output-affecting flags only. */
	flags: string[];
}

export function computeCoreHash(inputs: CoreHashInputs): string {
	const hash = createHash("sha256");
	hash.update(`pi-coding-agent=${inputs.piPkgVersion}\0`);
	hash.update(`bun=${inputs.bunVersion}\0`);
	hash.update(`entry=${inputs.entry}\0`);
	hash.update(`flags=${[...inputs.flags].sort().join(",")}\0`);
	hashTree(hash, join(inputs.piAgentDir, "src"), "src");
	return hash.digest("hex");
}

export interface CachedCore {
	/** The cache file — hardlink (never copy) from it into the version dir. */
	cacheFile: string;
	/** True when the core already existed (the compile was skipped). */
	cached: boolean;
	bytes: number;
}

/**
 * Return the cache entry for `hash`, compiling it on miss via `compile`.
 * The compile lands at a temp path first and is renamed into place, so a
 * failed compile never poisons the cache with a partial binary.
 */
export async function ensureCachedCore(opts: {
	outRoot: string;
	hash: string;
	compile: (outFile: string) => Promise<void>;
}): Promise<CachedCore> {
	const dir = join(opts.outRoot, CORES_DIR);
	const cacheFile = join(dir, opts.hash);
	if (existsSync(cacheFile)) {
		return { cacheFile, cached: true, bytes: statSync(cacheFile).size };
	}
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.tmp-${opts.hash.slice(0, 12)}-${process.pid}`);
	await opts.compile(tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, cacheFile);
	return { cacheFile, cached: false, bytes: statSync(cacheFile).size };
}

/** Hardlink the cached core into a version dir as its `pi-agent`. */
export function linkCore(cacheFile: string, binaryPath: string): void {
	linkSync(cacheFile, binaryPath);
}
