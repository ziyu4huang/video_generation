/**
 * Tests for runLocalCi — the pure orchestration behind the `local_ci` tool.
 *
 * Style mirrors tests/gh.test.ts: a RECORDING fake `SpawnFn` returns canned
 * results by match and records every call, so the whole flow runs with NO real
 * shell / git / filesystem. The fake is extended to also record `cwd`, because
 * ci-recipe drives commands in several directories (per-package `bun run test`
 * inside each `bun-apps/<pkg>/`), and distinguishing "package A ran" from
 * "package B ran" requires observing the cwd. `readPkg` is injected too, so the
 * fake never touches package.json.
 *
 * Change-package DETECTION (the former scripts/ci-changed-packages.sh) is now
 * extension-native TS (src/changed-packages.ts) and is injected here via the
 * `detectChangedPackages` seam — so these tests exercise the recipe's
 * CONSUMPTION of the detection map (true-filtering, --all keys, explicit-list
 * short-circuit, detection-error → fail), NOT detection internals. The latter
 * live in tests/changed-packages.test.ts as direct unit tests of
 * `computeChangedPackages`.
 */
import { test, expect, describe } from "bun:test";
import { runLocalCi, type CiOutcome } from "../src/ci-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { ComputeChangedPackagesOptions, ChangedPackagesMap } from "../src/changed-packages.js";

const REPO = "/repo";
const pkgDir = (name: string) => `${REPO}/bun-apps/${name}`;
/** Pull the package name out of a recorded call's cwd (last path segment). */
const pkgOf = (cwd: string) => cwd.split("/bun-apps/")[1] ?? "";

interface Rec {
	cmd: string;
	args: string[];
	cwd: string;
}

/** Recording spawn: records {cmd,args,cwd} + returns canned results by match. */
function mkSpawn(responses: Array<{ match: (cmd: string, args: string[], cwd: string) => boolean; result: SpawnResult }>) {
	const calls: Rec[] = [];
	const fn: SpawnFn = async (cmd, args, options) => {
		const cwd = options?.cwd ?? "";
		calls.push({ cmd, args, cwd });
		return responses.find((r) => r.match(cmd, args, cwd))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** Build an injectable readPkg from a name → scripts map. */
function mkReadPkg(byName: Record<string, Record<string, string> | undefined>) {
	return async (dir: string): Promise<{ scripts?: Record<string, string> }> => ({ scripts: byName[pkgOf(dir)] });
}

/** Recording detect fn: returns a fixed map + records the opts it was called with. */
function mkDetect(map: ChangedPackagesMap) {
	const calls: ComputeChangedPackagesOptions[] = [];
	const fn = async (opts: ComputeChangedPackagesOptions): Promise<ChangedPackagesMap> => {
		calls.push(opts);
		return { ...map };
	};
	return { fn, calls };
}

/** Matchers reused across cases. */
const verifyOk = (base = "origin/main") => ({
	match: (c, a) => c === "git" && a.includes("--verify") && a[a.length - 1] === base,
	result: { stdout: "deadbeef\n", stderr: "", exitCode: 0 },
});

describe("runLocalCi — detection + scoping", () => {
	test("detection keeps only true packages; the false-marked one NOT run; overall pass", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const detect = mkDetect({ "pi-agent-ext-core-task": true, "pi-agent-ext-research-tool": false });
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect.fn,
			readPkg: mkReadPkg({
				"pi-agent-ext-core-task": { typecheck: "tsc --noEmit", test: "bun test" },
				"pi-agent-ext-research-tool": { typecheck: "tsc --noEmit", test: "bun test" },
			}),
			// gates off so the assertion is purely about package scoping.
			includeGates: false,
		});
		expect(out.overall).toBe("pass");
		expect(out.packages.map((p) => p.name)).toEqual(["pi-agent-ext-core-task"]);

		const testPkgs = calls.filter((c) => c.cmd === "bun" && c.args[0] === "run" && c.args[1] === "test").map((c) => pkgOf(c.cwd));
		expect(testPkgs).toEqual(["pi-agent-ext-core-task"]);
		// research-tool was marked false → never spawned at all.
		expect(calls.some((c) => pkgOf(c.cwd) === "pi-agent-ext-research-tool")).toBe(false);
	});

	test("all=true invokes detection with all:true and runs EVERY listed package", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const detect = mkDetect({ "pkg-a": true, "pkg-b": true });
		await runLocalCi({
			repoRoot: REPO,
			all: true,
			spawn: fn,
			detectChangedPackages: detect.fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" }, "pkg-b": { test: "bun test" } }),
			includeGates: false,
		});
		// the --all variant was used (detect got all:true, no baseRef/headRef) …
		expect(detect.calls[0].all).toBe(true);
		expect(detect.calls[0].baseRef).toBeUndefined();
		expect(detect.calls[0].headRef).toBeUndefined();
		// both packages from the all-true map ran their tests.
		const testPkgs = calls.filter((c) => c.cmd === "bun" && c.args[1] === "test").map((c) => pkgOf(c.cwd)).sort();
		expect(testPkgs).toEqual(["pkg-a", "pkg-b"]);
	});

	test("explicit packages skip detection entirely", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const detect = mkDetect({});
		await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-x"],
			spawn: fn,
			detectChangedPackages: detect.fn,
			readPkg: mkReadPkg({ "pkg-x": { test: "bun test" } }),
			includeGates: false,
		});
		// detection was never invoked (explicit list short-circuits before it).
		expect(detect.calls.length).toBe(0);
		expect(calls.some((c) => c.cmd === "bun" && c.args[1] === "test" && pkgOf(c.cwd) === "pkg-x")).toBe(true);
	});
});

describe("runLocalCi — aggregation", () => {
	test("a package's test exit 1 → overall fail", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{ match: (c, a, cwd) => c === "bun" && a[1] === "test" && pkgOf(cwd) === "pkg-a", result: { stdout: "", stderr: "boom", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.overall).toBe("fail");
		expect(out.packages[0].test.exitCode).toBe(1);
	});

	test("a package with NO test script → test exit -1 (counts as pass)", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": {} }),
			includeGates: false,
		});
		expect(out.packages[0].test.exitCode).toBe(-1);
		expect(out.packages[0].test.note).toBe("no test script");
		expect(out.overall).toBe("pass");
	});

	test("blocking gate ci-file-size-guard.sh exit 1 → overall fail", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{ match: (c, a) => c === "bash" && a[0] === "scripts/ci-file-size-guard.sh", result: { stdout: "", stderr: "too big", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		});
		expect(out.overall).toBe("fail");
		expect(out.gates.find((g) => g.name === "ci-file-size-guard.sh")?.exitCode).toBe(1);
	});

	test("schema-cost exit 1 is info-only → overall still pass", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			// runSchemaCostCheck is IMPORTED now (no `bun scripts/check-schema-cost.ts`
			// spawn); its internal tools-metrics spawn is the one faked here.
			{ match: (c, a) => c === "bun" && a.includes("tools-metrics") && a.includes("--schema-cost") && a.includes("--json"), result: { stdout: "", stderr: "", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		});
		expect(out.overall).toBe("pass");
		expect(out.schemaCost?.exitCode).toBe(1);
		expect(out.schemaCost?.note).toMatch(/info-only/);
	});
});

describe("runLocalCi — typecheck precedence", () => {
	const base = () => mkSpawn([verifyOk()]);
	const detect = () => mkDetect({ "pkg-a": true });

	test("scripts.typecheck present → runs `bun run typecheck`", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", test: "bun test" } }),
			includeGates: false,
		});
		expect(calls.some((c) => c.cmd === "bun" && c.args.join(" ") === "run typecheck")).toBe(true);
		expect(out.packages[0].typecheck?.skipped).toBeFalsy();
	});

	test("no typecheck but scripts.check runs tsc → runs `bun run check`", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { check: "tsc --noEmit", test: "bun test" } }),
			includeGates: false,
		});
		expect(calls.some((c) => c.cmd === "bun" && c.args.join(" ") === "run check")).toBe(true);
		expect(calls.some((c) => c.args.join(" ") === "run typecheck")).toBe(false);
		expect(out.packages[0].typecheck?.exitCode).toBe(0);
	});

	test("no typecheck + scripts.check is biome (not tsc) → typecheck skipped", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { check: "biome check .", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].typecheck?.skipped).toBe(true);
		expect(out.packages[0].typecheck?.note).toBe("no tsc key");
		// neither typecheck nor check was spawned.
		expect(calls.some((c) => c.args[0] === "run" && (c.args[1] === "typecheck" || c.args[1] === "check"))).toBe(false);
		// test still ran.
		expect(calls.some((c) => c.args.join(" ") === "run test")).toBe(true);
	});
});

describe("runLocalCi — strict audit gates", () => {
	const AUDIT = ["test-determinism-audit.sh", "test-portability-audit.sh", "check-workflow-patterns.mjs", "verify-skills.ts"];

	test("strict=true spawns the audit gates", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			strict: true,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		});
		for (const file of AUDIT) {
			expect(calls.some((c) => c.args.includes(`scripts/${file}`)), `spawned ${file}`).toBe(true);
		}
	});

	test("strict=false (default) does NOT spawn the audit gates", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		});
		for (const file of AUDIT) {
			expect(calls.some((c) => c.args.includes(`scripts/${file}`)), `did NOT spawn ${file}`).toBe(false);
		}
		// the always-on v1 gates still ran.
		expect(calls.some((c) => c.args.includes("scripts/ci-file-size-guard.sh"))).toBe(true);
	});

	test("includeGates=false skips ALL gates + schema-cost", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out: CiOutcome = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.gates).toEqual([]);
		expect(out.schemaCost).toBeUndefined();
		// no GATE script ran.
		// NB: schema-cost is no longer a spawned script — runSchemaCostCheck is an
		// in-process import, and it is skipped entirely when includeGates=false, so
		// the tools-metrics instrument spawn never happens either.
		const gateFiles = [
			"ci-file-size-guard.sh", "check-lockfile-duplicate-versions.sh",
			"test-determinism-audit.sh", "test-portability-audit.sh", "check-workflow-patterns.mjs", "verify-skills.ts",
		];
		for (const f of gateFiles) {
			expect(calls.some((c) => c.args.includes(`scripts/${f}`)), `did NOT spawn gate ${f}`).toBe(false);
		}
		expect(calls.some((c) => c.args.includes("tools-metrics") && c.args.includes("--schema-cost")), "did NOT spawn tools-metrics").toBe(false);
	});
});

describe("runLocalCi — base-ref guard", () => {
	test("missing baseRef (git rev-parse --verify exit 1) → throws (stays offline)", async () => {
		const { fn, calls } = mkSpawn([
			{ match: (c, a) => c === "git" && a.includes("--verify"), result: { stdout: "", stderr: "unknown revision", exitCode: 128 } },
		]);
		const detect = mkDetect({});
		await expect(
			runLocalCi({ repoRoot: REPO, spawn: fn, detectChangedPackages: detect.fn, readPkg: mkReadPkg({}), includeGates: false }),
		).rejects.toThrow(/base ref "origin\/main" could not be resolved/);
		// nothing else ran (no detection, no gates).
		expect(detect.calls.length).toBe(0);
	});
});

describe("runLocalCi — detection failure fails LOUD (no false-green) [review M3]", () => {
	test("computeChangedPackages throws → overall fail; NO per-package spawns; NO gate spawns", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			// detection now lives in-process; a genuine I/O failure surfaces as a
			// throw. Simulate it to prove a detection error still fails LOUD.
			detectChangedPackages: async () => {
				throw new Error("git binary vanished");
			},
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", test: "bun test" } }),
			// gates left ON deliberately: a detection error must skip them regardless.
		});
		expect(out.overall).toBe("fail");
		expect(out.packages).toEqual([]);
		expect(out.gates).toEqual([]);
		expect(out.detectionError).toMatch(/detection failed: git binary vanished/);
		// no per-package spawns (no `bun run test` / `bun run typecheck` anywhere).
		expect(calls.some((c) => c.cmd === "bun" && c.args[0] === "run" && (c.args[1] === "test" || c.args[1] === "typecheck"))).toBe(false);
		// no gate spawns.
		expect(calls.some((c) => c.args[0] === "scripts/ci-file-size-guard.sh")).toBe(false);
		expect(calls.some((c) => c.args[0] === "scripts/check-lockfile-duplicate-versions.sh")).toBe(false);
	});

	test("--all detection throws → overall fail; detectionError set; base/head variant NOT used", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		let sawAll = false;
		const out = await runLocalCi({
			repoRoot: REPO,
			all: true,
			spawn: fn,
			detectChangedPackages: async (opts) => {
				if (opts.all) sawAll = true;
				throw new Error("fs exploded");
			},
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		});
		expect(sawAll).toBe(true); // the --all branch was the one that threw
		expect(out.overall).toBe("fail");
		expect(out.detectionError).toMatch(/detection failed: fs exploded/);
		expect(out.packages).toEqual([]);
		// no package ran.
		expect(calls.some((c) => c.cmd === "bun" && c.args[1] === "test")).toBe(false);
	});
});
