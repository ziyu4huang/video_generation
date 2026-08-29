import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBunBinary, parseBunAcquireChannel } from "../src/deploy/lib/bun-acquire.ts";
import { computeBunHash } from "../src/deploy/lib/bun-cache.ts";
import { parseTargetName } from "../src/deploy/lib/targets.ts";

/**
 * acquireBunBinary against a LOCAL fixture release dir shaped like the
 * GitHub tag directory (crossos t05/D7): `<base>/bun-v<ver>/<artifact>.zip`
 * + SHASUMS256.txt. The zip's payload is this process's own bun (a real
 * Mach-O we did not build — exactly the artifact kind the channel ships);
 * the target identity is explicit, so the bytes never need to match it.
 * No network: the releaseBase override is the seam the real download
 * shares with this fixture.
 */

const work = mkdtempSync(join(tmpdir(), "t05-acquire-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const FAKE_VERSION = "9.9.9-t05fixture";

let fixtureSeq = 0;

function buildFixtureRelease(specName: string, artifact: string, exeName: string): string {
	// Each call gets its OWN release dir: a rebuilt zip's bytes differ, and a
	// shared tagDir's SHASUMS would pin the stale digest. The glibc/musl
	// collision test builds its pair inside one dir via the append below.
	const seq = fixtureSeq++;
	const base = join(work, `release-${seq}`);
	const tagDir = join(base, `bun-v${FAKE_VERSION}`);
	mkdirSync(tagDir, { recursive: true });
	const payloadRoot = join(work, `payload-${seq}`);
	const payloadDir = join(payloadRoot, artifact.replace(/\.zip$/, ""));
	mkdirSync(payloadDir, { recursive: true });
	copyFileSync(process.execPath, join(payloadDir, exeName));
	const zip = join(tagDir, artifact);
	const tar = Bun.spawnSync(["tar", "-cf", zip, "--format", "zip", "-C", payloadRoot, artifact.replace(/\.zip$/, "")], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (tar.exitCode !== 0) throw new Error(`fixture zip build failed: ${tar.stderr.toString()}`);
	const digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
	const shasumsPath = join(tagDir, "SHASUMS256.txt");
	const existing = existsSync(shasumsPath) ? readFileSync(shasumsPath, "utf8") : "";
	writeFileSync(shasumsPath, `${existing}${digest}  ${artifact}\n`);
	return base;
}

/**
 * Local fixture REGISTRY for the npm channel: `<registry>/<pkg with "/" as
 * %2F>` metadata file whose dist.tarball is a RELATIVE filename resolved
 * next to it (the local-mirror seam acquireFromNpm documents). The tgz
 * payload is this process's own bun nested at `package/bin/<exe>` — the
 * layout @oven's real tarball ships.
 */
function buildFixtureRegistry(pkg: string, exeName: string): { registry: string; artifact: string } {
	const seq = fixtureSeq++;
	const registry = join(work, `registry-${seq}`);
	mkdirSync(registry, { recursive: true });
	const payloadRoot = join(work, `payload-${seq}`);
	mkdirSync(join(payloadRoot, "package", "bin"), { recursive: true });
	copyFileSync(process.execPath, join(payloadRoot, "package", "bin", exeName));
	const artifact = `bun-fixture-${seq}.tgz`;
	const tgz = join(registry, artifact);
	const tar = Bun.spawnSync(["tar", "-czf", tgz, "-C", payloadRoot, "package"], { stdout: "pipe", stderr: "pipe" });
	if (tar.exitCode !== 0) throw new Error(`fixture tgz build failed: ${tar.stderr.toString()}`);
	const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
	const metadata = { versions: { [FAKE_VERSION]: { dist: { integrity, tarball: artifact } } } };
	writeFileSync(join(registry, pkg.replace("/", "%2F")), JSON.stringify(metadata));
	return { registry, artifact };
}

describe("acquireBunBinary (D7: GitHub-release channel, local fixture)", () => {
	test("checksum-verified fetch lands in .buns under the SAME parameterized hash", async () => {
		const base = buildFixtureRelease("darwin-x64", "bun-darwin-x64.zip", "bun");
		const outRoot = join(work, "out-a");
		const spec = parseTargetName("darwin-x64");
		const r = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, releaseBase: base });
		expect(r.cached).toBe(false);
		const expectedHash = computeBunHash({ bunVersion: FAKE_VERSION, platform: "darwin", arch: "x64" });
		expect(existsSync(join(outRoot, ".buns", expectedHash))).toBe(true);
		expect(readFileSync(r.cacheFile).equals(readFileSync(process.execPath))).toBe(true); // payload survived the zip round-trip
		expect(statSync(r.cacheFile).mode & 0o111).not.toBe(0); // executable
	});

	test("second acquire of the same identity is a cache hit — no refetch", async () => {
		const base = buildFixtureRelease("darwin-x64", "bun-darwin-x64.zip", "bun");
		const outRoot = join(work, "out-b");
		const spec = parseTargetName("darwin-x64");
		await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, releaseBase: base });
		const r2 = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, releaseBase: base });
		expect(r2.cached).toBe(true);
	});

	test("a warm cache needs NO network at all — an unreachable releaseBase still succeeds", async () => {
		// The cache check runs BEFORE any fetch: cache-warm + release-down
		// (here: a base that does not exist) must be a hit, not a hard fail.
		const base = buildFixtureRelease("win32-x64", "bun-windows-x64.zip", "bun.exe");
		const outRoot = join(work, "out-warm");
		const spec = parseTargetName("win32-x64");
		// channel pinned github: the FIRST acquire must stay offline (fixture),
		// and auto would route win32-x64 at the npm registry.
		await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, releaseBase: base, channel: "github" });
		const r2 = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, releaseBase: "/nonexistent/release/base" });
		expect(r2.cached).toBe(true);
	});

	test(
		"glibc and musl never collide on one .buns entry (libc hash term)",
		async () => {
			// Same platform+arch, different libc → different artifacts, and the
			// cache must key them apart (the t05 review's collision finding).
			// Explicit timeout: two tar --format=zip fixture builds + two
			// acquisitions exceed bun's default 5s under local_ci's parallel
			// package load (observed flaking 2026-08-29 while the devops suite
			// grew with the standalone-shim build tests).
			const gBase = buildFixtureRelease("linux-x64", "bun-linux-x64.zip", "bun");
			const mBase = buildFixtureRelease("linux-x64", "bun-linux-x64-musl.zip", "bun");
			const outRoot = join(work, "out-libc");
			const g = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec: parseTargetName("linux-x64"), releaseBase: gBase });
			const m = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec: parseTargetName("linux-x64-musl"), releaseBase: mBase });
			expect(g.cacheFile).not.toBe(m.cacheFile);
		},
		{ timeout: 60_000 },
	);

	test("a tampered checksum fails the deploy before anything ships", async () => {
		const base = buildFixtureRelease("win32-x64", "bun-windows-x64.zip", "bun.exe");
		const tagDir = join(base, `bun-v${FAKE_VERSION}`);
		const artifact = "bun-windows-x64.zip";
		writeFileSync(join(tagDir, "SHASUMS256.txt"), `${"0".repeat(64)}  ${artifact}\n`);
		const outRoot = join(work, "out-c");
		await expect(
			// channel pinned: win32-x64 would otherwise AUTO to the npm channel
			// (which never reads SHASUMS) — this test is the github channel's.
			acquireBunBinary({
				outRoot,
				bunVersion: FAKE_VERSION,
				spec: parseTargetName("win32-x64"),
				releaseBase: base,
				channel: "github",
			}),
		).rejects.toThrow(/checksum mismatch/);
		expect(existsSync(join(outRoot, ".buns"))).toBe(false); // nothing cached from a failed verify
	});

	test("a SHASUMS row missing the artifact is an error, not a skip", async () => {
		const base = buildFixtureRelease("win32-x64", "bun-windows-x64.zip", "bun.exe");
		const tagDir = join(base, `bun-v${FAKE_VERSION}`);
		writeFileSync(join(tagDir, "SHASUMS256.txt"), `${"a".repeat(64)}  bun-some-other-target.zip\n`);
		await expect(
			// channel pinned github for the same reason as the tampered test above.
			acquireBunBinary({
				outRoot: join(work, "out-d"),
				bunVersion: FAKE_VERSION,
				spec: parseTargetName("win32-x64"),
				releaseBase: base,
				channel: "github",
			}),
		).rejects.toThrow(/no row for/);
	});
});

describe("acquireBunBinary (npm channel, local fixture registry)", () => {
	test(
		"auto routes win32-x64 at npm; sha512-verified tgz lands in .buns under the SAME hash",
		async () => {
			const { registry } = buildFixtureRegistry("@oven/bun-windows-x64", "bun.exe");
			const outRoot = join(work, "out-npm-a");
			const spec = parseTargetName("win32-x64");
			const r = await acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec, npmRegistry: registry });
			expect(r.cached).toBe(false);
			const expectedHash = computeBunHash({ bunVersion: FAKE_VERSION, platform: "win32", arch: "x64" });
			expect(r.cacheFile.endsWith(join(".buns", expectedHash))).toBe(true);
			expect(readFileSync(r.cacheFile).equals(readFileSync(process.execPath))).toBe(true); // payload survived the tgz round-trip
			// Second acquire is a cache hit — no registry touch at all.
			const r2 = await acquireBunBinary({
				outRoot,
				bunVersion: FAKE_VERSION,
				spec,
				npmRegistry: "/nonexistent/registry",
			});
			expect(r2.cached).toBe(true);
		},
		{ timeout: 60_000 },
	);

	test(
		"channel github stays available for win32 (explicit override of the npm default)",
		async () => {
			const base = buildFixtureRelease("win32-x64", "bun-windows-x64.zip", "bun.exe");
			const outRoot = join(work, "out-npm-gh");
			const r = await acquireBunBinary({
				outRoot,
				bunVersion: FAKE_VERSION,
				spec: parseTargetName("win32-x64"),
				releaseBase: base,
				channel: "github",
			});
			expect(r.cached).toBe(false);
		},
		{ timeout: 60_000 },
	);

	test("a tampered npm integrity fails before anything ships", async () => {
		const { registry, artifact } = buildFixtureRegistry("@oven/bun-windows-x64", "bun.exe");
		const metadataPath = join(registry, "@oven%2Fbun-windows-x64");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			versions: Record<string, { dist: { integrity: string; tarball: string } }>;
		};
		metadata.versions[FAKE_VERSION].dist.integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
		writeFileSync(metadataPath, JSON.stringify(metadata));
		const outRoot = join(work, "out-npm-b");
		await expect(
			acquireBunBinary({ outRoot, bunVersion: FAKE_VERSION, spec: parseTargetName("win32-x64"), npmRegistry: registry }),
		).rejects.toThrow(/npm tarball checksum mismatch/);
		expect(existsSync(join(outRoot, ".buns"))).toBe(false); // nothing cached from a failed verify
		expect(artifact).toBeTruthy();
	});

	test("a registry without the exact version is an error, not a skip", async () => {
		const { registry } = buildFixtureRegistry("@oven/bun-windows-x64", "bun.exe");
		const metadataPath = join(registry, "@oven%2Fbun-windows-x64");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			versions: Record<string, unknown>;
		};
		delete metadata.versions[FAKE_VERSION];
		writeFileSync(metadataPath, JSON.stringify(metadata));
		await expect(
			acquireBunBinary({
				outRoot: join(work, "out-npm-c"),
				bunVersion: FAKE_VERSION,
				spec: parseTargetName("win32-x64"),
				npmRegistry: registry,
			}),
		).rejects.toThrow(/no version .* for @oven\/bun-windows-x64/);
	});

	test("forced npm on a target with no published package is an error, not a silent switch", async () => {
		await expect(
			acquireBunBinary({
				outRoot: join(work, "out-npm-d"),
				bunVersion: FAKE_VERSION,
				spec: parseTargetName("darwin-arm64"),
				channel: "npm",
			}),
		).rejects.toThrow(/publishes no package/);
	});

	test("non-win32 targets keep the github channel under auto (registry never consulted)", async () => {
		const base = buildFixtureRelease("linux-x64", "bun-linux-x64.zip", "bun");
		const r = await acquireBunBinary({
			outRoot: join(work, "out-npm-e"),
			bunVersion: FAKE_VERSION,
			spec: parseTargetName("linux-x64"),
			releaseBase: base,
			npmRegistry: "/nonexistent/registry",
		});
		expect(r.cached).toBe(false); // proved github path ran despite a dead npmRegistry
	});
});

describe("parseBunAcquireChannel (S2_AGENT_BUN_ACQUIRE_CHANNEL)", () => {
	test("unset/empty → auto; strict vocabulary otherwise", () => {
		expect(parseBunAcquireChannel(undefined)).toBe("auto");
		expect(parseBunAcquireChannel("")).toBe("auto");
		expect(parseBunAcquireChannel("github")).toBe("github");
		expect(parseBunAcquireChannel("npm")).toBe("npm");
		expect(parseBunAcquireChannel("auto")).toBe("auto");
		expect(() => parseBunAcquireChannel("NPM")).toThrow(/invalid S2_AGENT_BUN_ACQUIRE_CHANNEL/);
		expect(() => parseBunAcquireChannel("release")).toThrow(/invalid S2_AGENT_BUN_ACQUIRE_CHANNEL/);
	});
});
