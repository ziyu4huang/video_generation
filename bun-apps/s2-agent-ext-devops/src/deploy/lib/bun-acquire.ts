/**
 * bun-acquire.ts — build-side acquisition of a non-host bun binary from a
 * GitHub release (crossos-deploy t05, D7).
 *
 * Channel: tag `bun-v<Bun.version>` on oven-sh/bun carries per-target zips
 * plus `SHASUMS256.txt`. Version is exact against the Bun.version the core
 * hash already folds — the launcher contract (runtime = the SAME bun that
 * built the bundle) is satisfied structurally. The fetched binary lands in
 * `.buns/<computeBunHash>` via ensureCachedBunFrom — the same hash function
 * the host path uses, so a cross-platform tree stays content-addressed.
 *
 * BUILD-side only (D3): nothing here runs or is required on a target
 * machine. A host-target deploy never calls into this file — no network,
 * Gate 5's offline posture untouched.
 *
 * `releaseBase` is overridable (tests point it at a local fixture directory
 * shaped like the release: `<artifact>.zip` + `SHASUMS256.txt`); it also
 * accepts a `file://` URL or plain path for local-release workflows.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNS_DIR, computeBunHash, ensureCachedBunFrom, type CachedBun } from "./bun-cache.ts";
import { githubBunArtifact, type TargetSpec } from "./targets.ts";

export const DEFAULT_RELEASE_BASE = "https://github.com/oven-sh/bun/releases/download";

function isHttp(u: string): boolean {
	return u.startsWith("http://") || u.startsWith("https://");
}

/** file:// URLs and plain paths resolve to the same local-dir reading. */
function localDirOf(u: string): string {
	return u.startsWith("file://") ? new URL(u).pathname : u;
}

/** Repo convention (session-doctor-cli, deploy-e2e-recipe): every outbound fetch is timeout-bounded — a black-holed connection must fail, not hang the deploy. */
const FETCH_TIMEOUT_MS = 60_000;

async function fetchBytes(url: string): Promise<Buffer> {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`bun release fetch failed: ${url} → HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
	if (!isHttp(url)) return readFileSync(localDirOf(url), "utf8");
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`bun release fetch failed: ${url} → HTTP ${res.status}`);
	return res.text();
}

/**
 * Parse `SHASUMS256.txt` (`<hex>  <filename>` lines, sha256sum format) and
 * return the digest recorded for `artifact`. A missing row is an error, not
 * a skip: D7's whole point is that the checksum is official and mandatory.
 */
export function digestFromShasums(text: string, artifact: string): string {
	for (const line of text.split("\n")) {
		const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
		if (m && m[2] === artifact) return m[1];
	}
	throw new Error(`SHASUMS256.txt has no row for "${artifact}" — refusing to ship an unverified binary`);
}

/** Acquire the target's bun into `.buns/<hash>`; cache hit → no network. */
export async function acquireBunBinary(opts: {
	outRoot: string;
	bunVersion: string;
	spec: TargetSpec;
	/** GitHub release download base; override for tests / local mirrors. */
	releaseBase?: string;
}): Promise<CachedBun> {
	const { outRoot, bunVersion, spec } = opts;
	// Cache FIRST: a warm .buns entry must not pay (or require) the network —
	// the matrix's second deploy of the same target is offline by design, and
	// "release down" must not fail a deploy whose binary is already on disk.
	const hash = computeBunHash({ bunVersion, platform: spec.platform, arch: spec.arch, libc: spec.libc });
	const cacheFile = join(outRoot, BUNS_DIR, hash);
	if (existsSync(cacheFile)) {
		return { cacheFile, cached: true, bytes: statSync(cacheFile).size };
	}
	const artifact = githubBunArtifact(spec);
	const base = opts.releaseBase ?? DEFAULT_RELEASE_BASE;
	const tag = `bun-v${bunVersion}`;
	const shasums = await fetchText(`${base}/${tag}/SHASUMS256.txt`);
	const expected = digestFromShasums(shasums, artifact);

	const zipBytes = isHttp(base)
		? await fetchBytes(`${base}/${tag}/${artifact}`)
		: readFileSync(join(localDirOf(base), tag, artifact));
	const actual = createHash("sha256").update(zipBytes).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`bun release checksum mismatch for ${artifact} (tag ${tag}): shasums ${expected}, downloaded ${actual}`,
		);
	}

	// Extract with bsdtar (`tar -xf` reads zip on macOS/Windows 10+; the
	// build host is a mac by D3). The zip nests one dir (bun-<target>/),
	// so the executable is found by name inside the extraction root.
	const work = mkdtempSync(join(tmpdir(), "s2-bun-acquire-"));
	try {
		const zipPath = join(work, artifact);
		writeFileSync(zipPath, zipBytes);
		const tar = Bun.spawnSync(["tar", "-xf", zipPath, "-C", work], { stdout: "pipe", stderr: "pipe" });
		if (tar.exitCode !== 0) {
			throw new Error(`bun release unzip failed (tar -xf): ${tar.stderr.toString().trim()}`);
		}
		const exe = findExe(work, spec.platform === "win32" ? "bun.exe" : "bun");
		if (!exe) throw new Error(`bun release zip ${artifact}: no bun executable found inside`);
		return ensureCachedBunFrom(exe, { outRoot, bunVersion, platform: spec.platform, arch: spec.arch, libc: spec.libc });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function findExe(root: string, name: string): string | null {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const p = join(root, entry.name);
		if (entry.isDirectory()) {
			const hit = findExe(p, name);
			if (hit) return hit;
		} else if (entry.name === name) {
			return p;
		}
	}
	return null;
}
