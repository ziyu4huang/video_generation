/**
 * bun-cache.ts — content-addressed cache for the SHIPPED bun runtime
 * (deploy-platform-neutral-core ticket 02).
 *
 * <outRoot>/.buns/<hash> holds one copy of each distinct bun; every version
 * directory hardlinks it as its `bin/bun`. The hash keys the runtime identity
 * (Bun.version, process.platform, process.arch) — the same identity the core
 * hash already folds Bun.version into, so a bun upgrade invalidates both
 * together. Measured bun 1.4.0 arm64: 63,558,256 B — hardlinking keeps the
 * per-version cost ~0 where a naive copy would add ~63 MB per deploy.
 *
 * Why ship bun at all: the core is a `--target=bun` ESM bundle — neutral, but
 * it needs a runtime to execute it, and the deploy tree is self-contained by
 * contract (Gate 5). The platform-neutrality claim is scoped to the bundle:
 * swapping `bin/bun` for another platform's same-version bun (or pointing
 * S2_AGENT_BUN at one) relocates the deploy across platforms without
 * rebuilding anything.
 *
 * Mirrors core-cache.ts deliberately: same hardlink-and-rename dance, same
 * nlink-based orphan collection, same grace window. Differences: the source
 * is process.execPath (a file we did not build — copied, never regenerated),
 * and no freeze/no-freeze split is needed because the entry is written once
 * and never chmod-ed by the deploy (freezeTree re-modes the hardlink, which
 * re-modes the cache entry — same inode, exactly like a frozen core).
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const BUNS_DIR = ".buns";

/** Hash the runtime identity: same bun version on the same platform/arch. */
export function computeBunHash(opts: { bunVersion: string; platform: string; arch: string }): string {
	return createHash("sha256")
		.update(`bun=${opts.bunVersion}\0platform=${opts.platform}\0arch=${opts.arch}\0`)
		.digest("hex");
}

export interface CachedBun {
	/** The cache file — hardlink (never copy) from it into the version dir. */
	cacheFile: string;
	/** True when the runtime already existed (the 63 MB copy was skipped). */
	cached: boolean;
	bytes: number;
}

/**
 * Return the cache entry for this process's bun, copying it in on miss via
 * `process.execPath`. The copy lands at a temp path first and is renamed into
 * place, so a killed copy never poisons the cache with a partial binary.
 */
export function ensureCachedBun(opts: { outRoot: string }): CachedBun {
	const hash = computeBunHash({ bunVersion: Bun.version, platform: process.platform, arch: process.arch });
	const dir = join(opts.outRoot, BUNS_DIR);
	const cacheFile = join(dir, hash);
	if (existsSync(cacheFile)) {
		return { cacheFile, cached: true, bytes: statSync(cacheFile).size };
	}
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.tmp-${hash.slice(0, 12)}-${process.pid}`);
	copyFileSync(process.execPath, tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, cacheFile);
	return { cacheFile, cached: false, bytes: statSync(cacheFile).size };
}

/** Hardlink the cached bun into a version dir as its `bin/bun`. */
export function linkBun(cacheFile: string, target: string): void {
	linkSync(cacheFile, target);
}

/** A cache entry younger than this is assumed to belong to a deploy still in flight. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface PrunedBun {
	hash: string;
	bytes: number;
}

/**
 * Drop runtime cache entries no version directory references any more — the
 * .buns twin of core-cache's pruneOrphanCores. Same mechanics: every live bun
 * has nlink ≥ 2 (cache + version-dir links), dotfiles skipped, grace window
 * covers the rename→link race of a concurrent deploy. Unlink only — never
 * chmod (a hardlink re-mode would touch every frozen version sharing it).
 */
export function pruneOrphanBuns(
	outRoot: string,
	opts: { now?: number; graceMs?: number } = {},
): PrunedBun[] {
	const dir = join(outRoot, BUNS_DIR);
	if (!existsSync(dir)) return [];
	const now = opts.now ?? Date.now();
	const graceMs = opts.graceMs ?? ORPHAN_GRACE_MS;

	const pruned: PrunedBun[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue;
		const file = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(file);
		} catch {
			continue; // vanished under us — a concurrent deploy already collected it
		}
		if (!st.isFile()) continue;
		if (st.nlink > 1) continue;
		if (now - st.mtimeMs < graceMs) continue;
		try {
			unlinkSync(file);
			pruned.push({ hash: name, bytes: st.size });
		} catch {
			// Left in place; the next deploy retries. Best-effort by construction.
		}
	}
	return pruned;
}
