/**
 * bun-acquire.ts — build-side acquisition of a non-host bun binary
 * (crossos-deploy t05, D7), over one of two channels:
 *
 * - **npm registry** (default for win32-x64): @oven publishes the windows-x64
 *   binary as `@oven/bun-windows-x64`; the tarball's `package/bin/bun.exe` is
 *   the same executable the release zip carries, and the registry's
 *   `dist.integrity` (sha512) is the official checksum.
 * - **GitHub release** (everything else): tag `bun-v<Bun.version>` on
 *   oven-sh/bun carries per-target zips plus `SHASUMS256.txt`.
 *
 * Version is exact against the Bun.version the core hash already folds —
 * the launcher contract (runtime = the SAME bun that built the bundle) is
 * satisfied structurally. The fetched binary lands in
 * `.buns/<computeBunHash>` via ensureCachedBunFrom — the same hash function
 * the host path uses, so a cross-platform tree stays content-addressed.
 *
 * BUILD-side only (D3): nothing here runs or is required on a target
 * machine. A host-target deploy never calls into this file — no network,
 * Gate 5's offline posture untouched.
 *
 * `releaseBase` / `npmRegistry` are overridable (tests point them at local
 * fixture directories shaped like the channel: `<artifact>.zip` +
 * `SHASUMS256.txt`, resp. a metadata file + relative tarball); both also
 * accept `file://` URLs or plain paths for local-mirror workflows.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { urlToFsPath } from "./fs.ts";
import { BUNS_DIR, computeBunHash, ensureCachedBunFrom, type CachedBun } from "./bun-cache.ts";
import { githubBunArtifact, npmBunPackage, type TargetSpec } from "./targets.ts";

export const DEFAULT_RELEASE_BASE = "https://github.com/oven-sh/bun/releases/download";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Acquisition channel for a non-host bun binary. `auto` prefers npm where @oven publishes a package (win32-x64) and falls back to the GitHub release elsewhere. */
export type BunAcquireChannel = "github" | "npm" | "auto";

/**
 * Parse the S2_AGENT_BUN_ACQUIRE_CHANNEL env value: unset/empty → undefined
 * (caller's default applies), otherwise a strict `github|npm|auto` — anything
 * else is an error, never a guess (a typo silently shipping from the wrong
 * channel is worse than a loud deploy failure).
 */
export function parseBunAcquireChannel(raw: string | undefined): BunAcquireChannel {
	if (raw === undefined || raw === "") return "auto";
	if (raw === "github" || raw === "npm" || raw === "auto") return raw;
	throw new Error(`invalid S2_AGENT_BUN_ACQUIRE_CHANNEL "${raw}" — expected github|npm|auto`);
}

function isHttp(u: string): boolean {
	return u.startsWith("http://") || u.startsWith("https://");
}

/** Repo convention (session-doctor-cli, deploy-e2e-recipe): every outbound fetch is timeout-bounded — a black-holed connection must fail, not hang the deploy. */
const FETCH_TIMEOUT_MS = 60_000;

async function fetchBytes(url: string): Promise<Buffer> {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`bun release fetch failed: ${url} → HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
	if (!isHttp(url)) return readFileSync(urlToFsPath(url), "utf8");
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
	/** npm registry base for the npm channel; override for tests / local mirrors. */
	npmRegistry?: string;
	/**
	 * Acquisition channel (default `auto`): npm where @oven publishes a
	 * package for the target (win32-x64), GitHub release otherwise. An
	 * explicit `npm` for a target with no package is an error, not a
	 * silent channel switch.
	 */
	channel?: BunAcquireChannel;
}): Promise<CachedBun> {
	const { outRoot, bunVersion, spec } = opts;
	// Cache FIRST: a warm .buns entry must not pay (or require) the network —
	// the matrix's second deploy of the same target is offline by design, and
	// "release down" must not fail a deploy whose binary is already on disk.
	// The hash has no channel term: a binary cached via one channel satisfies
	// the other (same version+platform+arch+libc → same bytes).
	const hash = computeBunHash({ bunVersion, platform: spec.platform, arch: spec.arch, libc: spec.libc });
	const cacheFile = join(outRoot, BUNS_DIR, hash);
	if (existsSync(cacheFile)) {
		return { cacheFile, cached: true, bytes: statSync(cacheFile).size };
	}
	const npmPkg = npmBunPackage(spec);
	const channel = opts.channel ?? "auto";
	if (channel === "npm" && !npmPkg) {
		throw new Error(`npm channel requested for ${spec.platform}-${spec.arch} but @oven publishes no package for it`);
	}
	const useNpm = channel === "npm" || (channel === "auto" && npmPkg !== null);
	if (useNpm && npmPkg) return acquireFromNpm({ ...opts, pkg: npmPkg });
	return acquireFromGithubRelease(opts);
}

/**
 * npm channel: fetch `<registry>/<pkg>` metadata, verify the tarball against
 * the version's registry-issued `dist.integrity` (sha512, base64 — npm's own
 * checksum, same official-source guarantee D7 demands of SHASUMS256), then
 * extract `package/bin/<exe>` (the tarball carries no bunx; bin/bun.exe alone).
 *
 * `npmRegistry` non-http points at a fixture dir: the metadata lives at
 * `<registry>/<pkg with "/" as %2F>` and a relative `dist.tarball` resolves
 * against the metadata file's dir — the same local-mirror seam releaseBase
 * gives the GitHub channel.
 */
async function acquireFromNpm(opts: {
	outRoot: string;
	bunVersion: string;
	spec: TargetSpec;
	npmRegistry?: string;
	pkg: string;
}): Promise<CachedBun> {
	const { outRoot, bunVersion, spec, pkg } = opts;
	const registry = opts.npmRegistry ?? DEFAULT_NPM_REGISTRY;
	const metadataPath = `${registry}/${pkg.replace("/", "%2F")}`;
	const metadataText = await fetchText(metadataPath);
	let versionDist: { integrity?: string; tarball?: string };
	try {
		const parsed = JSON.parse(metadataText) as { versions?: Record<string, { dist?: { integrity?: string; tarball?: string } }> };
		versionDist = parsed.versions?.[bunVersion]?.dist ?? {};
	} catch (e) {
		throw new Error(`npm registry metadata for ${pkg} is not valid JSON: ${(e as Error).message}`);
	}
	if (!versionDist.integrity || !versionDist.tarball) {
		throw new Error(`npm registry has no version ${bunVersion} for ${pkg} — refusing to ship an unverified binary`);
	}
	const expected = versionDist.integrity;
	if (!expected.startsWith("sha512-")) {
		throw new Error(`npm package ${pkg}@${bunVersion} integrity is not sha512 (${expected})`);
	}

	// tarball: registry URL when http; a fixture path (relative to the
	// metadata file) when the registry base is a local dir.
	const tarballBytes = isHttp(versionDist.tarball)
		? await fetchBytes(versionDist.tarball)
		: readFileSync(join(isHttp(registry) ? "." : dirname(urlToFsPath(metadataPath)), urlToFsPath(versionDist.tarball)));
	const actual = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
	if (actual !== expected) {
		throw new Error(`npm tarball checksum mismatch for ${pkg}@${bunVersion}: registry ${expected}, downloaded ${actual}`);
	}

	// Extract with the same bsdtar the GitHub channel uses (tar -xf reads
	// .tgz natively); the exe is `package/bin/<name>`, found by name inside
	// the extraction root.
	const work = mkdtempSync(join(tmpdir(), "s2-bun-acquire-npm-"));
	try {
		const tgzPath = join(work, "package.tgz");
		writeFileSync(tgzPath, tarballBytes);
		const tar = Bun.spawnSync(["tar", "-xf", tgzPath, "-C", work], { stdout: "pipe", stderr: "pipe" });
		if (tar.exitCode !== 0) {
			throw new Error(`npm tarball extract failed (tar -xf): ${tar.stderr.toString().trim()}`);
		}
		const exe = findExe(work, spec.platform === "win32" ? "bun.exe" : "bun");
		if (!exe) throw new Error(`npm tarball ${pkg}@${bunVersion}: no bun executable found inside`);
		return ensureCachedBunFrom(exe, { outRoot, bunVersion, platform: spec.platform, arch: spec.arch, libc: spec.libc });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function acquireFromGithubRelease(opts: {
	outRoot: string;
	bunVersion: string;
	spec: TargetSpec;
	releaseBase?: string;
}): Promise<CachedBun> {
	const { outRoot, bunVersion, spec } = opts;
	const artifact = githubBunArtifact(spec);
	const base = opts.releaseBase ?? DEFAULT_RELEASE_BASE;
	const tag = `bun-v${bunVersion}`;
	const shasums = await fetchText(`${base}/${tag}/SHASUMS256.txt`);
	const expected = digestFromShasums(shasums, artifact);

	const zipBytes = isHttp(base)
		? await fetchBytes(`${base}/${tag}/${artifact}`)
		: readFileSync(join(urlToFsPath(base), tag, artifact));
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
