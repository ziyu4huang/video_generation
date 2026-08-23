/**
 * Tests for runLocalCi — the pure orchestration behind the `run_local_ci` tool.
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
import { LOCAL_ONLY_AUDITS } from "../src/ci-gates.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { ComputeChangedPackagesOptions, ChangedPackagesMap } from "../src/changed-packages.js";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

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

/**
 * Injectable gate reader. The REAL one parses the repo's workflow; these tests
 * run against a fake REPO path, so every case that leaves gates on injects this
 * instead. Two rows on purpose: one at the repo root, one with a
 * `working-directory`, since running a `bun-apps` gate from the root fails.
 */
const GATE_FILE_SIZE = { name: "File-size guard (2 MB, blocks)", cwd: ".", run: "bash scripts/ci-file-size-guard.sh" };
const GATE_DEPS = { name: "Dependency-direction guard (blocks)", cwd: "bun-apps", run: "bun run test:deps" };
const fakeGates =
  (gates = [GATE_FILE_SIZE, GATE_DEPS]) =>
  async () => ({ gates });

/** Matchers reused across cases. */
const verifyOk = (base = "origin/main") => ({
	match: (c: string, a: string[]) => c === "git" && a.includes("--verify") && a[a.length - 1] === base,
	result: { stdout: "deadbeef\n", stderr: "", exitCode: 0 },
});

describe("runLocalCi — detection + scoping", () => {
	test("detection keeps only true packages; the false-marked one NOT run; overall pass", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const detect = mkDetect({ "s2-agent-ext-task": true, "s2-agent-ext-research-tool": false });
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect.fn,
			readPkg: mkReadPkg({
				"s2-agent-ext-task": { typecheck: "tsc --noEmit", test: "bun test" },
				"s2-agent-ext-research-tool": { typecheck: "tsc --noEmit", test: "bun test" },
			}),
			// gates off so the assertion is purely about package scoping.
			includeGates: false,
		});
		expect(out.overall).toBe("pass");
		expect(out.packages.map((p) => p.name)).toEqual(["s2-agent-ext-task"]);

		const testPkgs = calls.filter((c) => c.cmd === "bun" && c.args[0] === "run" && c.args[1] === "test").map((c) => pkgOf(c.cwd));
		expect(testPkgs).toEqual(["s2-agent-ext-task"]);
		// research-tool was marked false → never spawned at all.
		expect(calls.some((c) => pkgOf(c.cwd) === "s2-agent-ext-research-tool")).toBe(false);
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

	test("a failing gate → overall fail", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{ match: (c, a) => c === "bash" && a[1] === GATE_FILE_SIZE.run, result: { stdout: "", stderr: "too big", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			readGates: fakeGates(),
		});
		expect(out.overall).toBe("fail");
		expect(out.gates.find((g) => g.name === GATE_FILE_SIZE.name)?.exitCode).toBe(1);
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
			readGates: fakeGates(),
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

	test("no typecheck + scripts.check is biome (not tsc) → typecheck skipped, lint runs it", async () => {
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
		// `typecheck` was never spawned...
		expect(calls.some((c) => c.args.join(" ") === "run typecheck")).toBe(false);
		// ...but `check` WAS — claimed by the lint phase, not the typecheck one.
		// The two phases read the same script name and must not both take it.
		expect(out.packages[0].lint?.exitCode).toBe(0);
		expect(calls.filter((c) => c.args.join(" ") === "run check").length).toBe(1);
		// test still ran.
		expect(calls.some((c) => c.args.join(" ") === "run test")).toBe(true);
	});
});

describe("runLocalCi — lint phase (biome), resolved by script name", () => {
	const detect = () => mkDetect({ "pkg-a": true });
	/** Recording spawn with `git rev-parse --verify` canned, plus optional failures
	 * keyed by the joined argv (e.g. `"run check": 1`). */
	const base = (failing: Record<string, number> = {}) =>
		mkSpawn([
			verifyOk(),
			...Object.entries(failing).map(([argv, exitCode]) => ({
				match: (_c: string, a: string[]) => a.join(" ") === argv,
				result: { stdout: "", stderr: "biome: 1 error", exitCode },
			})),
		]);

	test("scripts.check running biome is the executor", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", check: "biome check .", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].lint?.exitCode).toBe(0);
		expect(out.packages[0].typecheck?.exitCode).toBe(0);
		expect(calls.some((c) => c.args.join(" ") === "run check")).toBe(true);
		expect(calls.some((c) => c.args.join(" ") === "run typecheck")).toBe(true);
	});

	test("scripts.check is PREFERRED over scripts.lint — `biome lint` skips format/organizeImports", async () => {
		const { fn, calls } = base();
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { check: "biome check .", lint: "biome lint .", test: "bun test" } }),
			includeGates: false,
		});
		expect(calls.some((c) => c.args.join(" ") === "run check")).toBe(true);
		expect(calls.some((c) => c.args.join(" ") === "run lint")).toBe(false);
	});

	test("scripts.lint is the fallback when check does not run biome", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { check: "tsc --noEmit", lint: "biome lint .", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].lint?.exitCode).toBe(0);
		// `check` here is the TYPECHECK executor; `lint` is the biome one.
		expect(out.packages[0].typecheck?.exitCode).toBe(0);
		expect(calls.some((c) => c.args.join(" ") === "run lint")).toBe(true);
	});

	test("no biome-running script → skipped, and nothing is spawned for it", async () => {
		const { fn, calls } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", lint: "eslint .", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].lint?.skipped).toBe(true);
		expect(out.packages[0].lint?.note).toBe("no biome key");
		expect(calls.some((c) => c.args.join(" ") === "run lint")).toBe(false);
	});

	test("a FAILED lint fails the whole run — the point of the phase", async () => {
		// The regression this pins: core-runtime's `bun run check` was red on
		// origin/main for days while local_ci reported pass, because no phase ran it.
		const { fn } = base({ "run check": 1 });
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { check: "biome check .", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].lint?.exitCode).toBe(1);
		expect(out.overall).toBe("fail");
	});

	test("a SKIPPED lint never fails the run", async () => {
		const { fn } = base();
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect().fn,
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].lint?.skipped).toBe(true);
		expect(out.overall).toBe("pass");
	});
});

describe("runLocalCi — gates come from the workflow, not a hand-written list", () => {
	const detect = () => mkDetect({ "pkg-a": true }).fn;
	const readPkg = () => mkReadPkg({ "pkg-a": { test: "bun test" } });

	test("runs EVERY gate the reader returns, as a shell command in the gate's own cwd", async () => {
		// The regression this pins: the old code ran two hardcoded files, so the
		// eight `bun run test:*` guards in the job — the ones merge_pr_after_local_ci is
		// supposed to gate on — never executed.
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
		});
		const gateCalls = calls.filter((c) => c.cmd === "bash" && c.args[0] === "-c");
		expect(gateCalls.map((c) => c.args[1])).toEqual([GATE_FILE_SIZE.run, GATE_DEPS.run]);
		// A `working-directory` row must run THERE — `bun run test:deps` at the
		// repo root would fail for a reason that has nothing to do with the guard.
		expect(gateCalls[0].cwd).toBe(REPO);
		expect(gateCalls[1].cwd).toBe(`${REPO}/bun-apps`);
		expect(out.gates.map((g) => g.name)).toEqual([GATE_FILE_SIZE.name, GATE_DEPS.name]);
	});

	test("every gate reports its wall-clock (durationMs) — the 591 s breach was diagnosed blind", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
		});
		for (const g of out.gates) expect(typeof g.durationMs).toBe("number");
	});

	const GATE_LOCKFILE = {
		name: "Lockfile freshness guard (package.json vs bun.lock, blocks)",
		cwd: ".",
		run: "bash scripts/check-lockfile-freshness.sh",
	};

	test("the lockfile-freshness gate runs ALONE and FIRST, before any package spawn", async () => {
		// It executes `bun install` — a mutating gate racing any other bun
		// process can observe a half-installed tree. Exclusive-first is the
		// contract that makes overlapping the REST of the gates safe.
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates([GATE_FILE_SIZE, GATE_LOCKFILE, GATE_DEPS]),
		});
		const firstBash = calls.find((c) => c.cmd === "bash")!;
		expect(firstBash.args[1]).toBe(GATE_LOCKFILE.run);
		// …and nothing else spawned before it (no typecheck, no test).
		const idxLockfile = calls.indexOf(firstBash);
		expect(calls.slice(0, idxLockfile).some((c) => c.cmd === "bun")).toBe(false);
		// Reported order is still the WORKFLOW's order (exclusive moves execution
		// only, never the report).
		expect(out.gates.map((g) => g.name)).toEqual([GATE_FILE_SIZE.name, GATE_LOCKFILE.name, GATE_DEPS.name]);
	});

	test("non-exclusive gates keep WORKFLOW order in the report even though they run as a pool", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const gateList = [
			GATE_FILE_SIZE,
			{ name: "g2", cwd: ".", run: "echo two" },
			{ name: "g3", cwd: ".", run: "echo three" },
			GATE_DEPS,
		];
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(gateList),
		});
		expect(out.gates.map((g) => g.name)).toEqual(gateList.map((g) => g.name));
	});

	test("when the test command itself runs typecheck, the phase-3a spawn is skipped as redundant", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-row": true, "pkg-plain": true }).fn,
			readPkg: mkReadPkg({
				"pkg-row": { typecheck: "tsc --noEmit", test: "bun test" },
				"pkg-plain": { typecheck: "tsc --noEmit", test: "bun test" },
			}),
			readMatrix: async () => ({ "pkg-row": "bun test && bun run typecheck" }),
			includeGates: false,
		});
		// pkg-row's typecheck ran ONCE (inside its row) — no separate spawn.
		expect(calls.filter((c) => c.cwd === pkgDir("pkg-row") && c.args[1] === "typecheck")).toHaveLength(0);
		expect(out.packages.find((p) => p.name === "pkg-row")?.typecheck?.skipped).toBe(true);
		// pkg-plain has no row → the phase spawn still runs.
		expect(calls.filter((c) => c.cwd === pkgDir("pkg-plain") && c.args[1] === "typecheck")).toHaveLength(1);
		expect(out.packages.find((p) => p.name === "pkg-plain")?.typecheck?.skipped).toBeUndefined();
	});

	test("extension packages' typecheck is left to the typecheck:ext gate when gates run", async () => {
		// Same tsc, same package, twice in one run = the measured ~250 s of
		// duplicated checking this dedup removes. The gate executor is the
		// authoritative copy (it also covers the --strict/no-diff packages).
		const tmp = mkdtempSync(join(tmpdir(), "ci-recipe-ext-"));
		try {
			// A REAL extensions/ entry — the predicate reads the tree, like the
			// gate executor's own discovery does. The recipe builds package dirs
			// as <repoRoot>/bun-apps/<name>, so the fixture must live there.
			mkdirSync(join(tmp, "bun-apps", "pkg-ext", "extensions"), { recursive: true });
			await Bun.write(join(tmp, "bun-apps", "pkg-ext", "extensions", "x.ts"), "export {};");
			const { fn, calls } = mkSpawn([verifyOk()]);
			const out = await runLocalCi({
				repoRoot: tmp,
				spawn: fn,
				detectChangedPackages: mkDetect({ "pkg-ext": true, "pkg-lib": true }).fn,
				readPkg: mkReadPkg({
					"pkg-ext": { typecheck: "tsc --noEmit", test: "bun test" },
					"pkg-lib": { typecheck: "tsc --noEmit", test: "bun test" },
				}),
				readGates: fakeGates(),
			});
			expect(out.packages.find((p) => p.name === "pkg-ext")?.typecheck).toEqual({
				exitCode: -1,
				skipped: true,
				note: "covered by the typecheck:ext gate",
			});
			// A non-extension package keeps its own phase-3a typecheck.
			expect(out.packages.find((p) => p.name === "pkg-lib")?.typecheck?.skipped).toBeUndefined();
			expect(calls.filter((c) => c.cwd.endsWith("pkg-lib") && c.args[1] === "typecheck")).toHaveLength(1);

			// With gates OFF the dedup must NOT apply — there is no gate to cover it.
			const { fn: fn2, calls: calls2 } = mkSpawn([verifyOk()]);
			const out2 = await runLocalCi({
				repoRoot: tmp,
				spawn: fn2,
				detectChangedPackages: mkDetect({ "pkg-ext": true }).fn,
				readPkg: mkReadPkg({ "pkg-ext": { typecheck: "tsc --noEmit", test: "bun test" } }),
				includeGates: false,
			});
			expect(out2.packages.find((p) => p.name === "pkg-ext")?.typecheck?.skipped).toBeUndefined();
			expect(calls2.filter((c) => c.cwd.endsWith("pkg-ext") && c.args[1] === "typecheck")).toHaveLength(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("any gate failing → overall fail", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{ match: (c, a) => c === "bash" && a[1] === GATE_DEPS.run, result: { stdout: "", stderr: "cycle", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
		});
		expect(out.overall).toBe("fail");
		expect(out.gates.find((g) => g.name === GATE_DEPS.name)?.exitCode).toBe(1);
	});

	test("an unreadable gate job → overall fail + gateError, and NO gate is spawned", async () => {
		// The whole point of ci-gates' inverted degradation contract: an empty gate
		// list is indistinguishable from "every gate passed". Failing closed here is
		// what stops that false-green from reaching `gh pr merge`.
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: async () => ({ gates: [], error: "no `regression-gates` job" }),
		});
		expect(out.overall).toBe("fail");
		expect(out.gateError).toContain("regression-gates");
		expect(out.gates).toEqual([]);
		expect(calls.some((c) => c.cmd === "bash" && c.args[0] === "-c")).toBe(false);
		// the per-package work still ran and is still reported.
		expect(out.packages).toHaveLength(1);
	});

	test("strict=true appends the audits that have NO workflow step", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			strict: true,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
		});
		for (const file of LOCAL_ONLY_AUDITS) {
			expect(out.gates.some((g) => g.name === file), `strict ran ${file}`).toBe(true);
		}
		// …and they run through the same shell path, after the derived gates.
		const shellCmds = calls.filter((c) => c.cmd === "bash" && c.args[0] === "-c").map((c) => c.args[1]);
		expect(shellCmds.slice(0, 2)).toEqual([GATE_FILE_SIZE.run, GATE_DEPS.run]);
	});

	test("strict=false (default) runs ONLY what CI runs", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
		});
		for (const file of LOCAL_ONLY_AUDITS) {
			expect(out.gates.some((g) => g.name === file), `did NOT run ${file}`).toBe(false);
		}
		expect(out.gates).toHaveLength(2);
	});

	test("includeGates=false skips ALL gates + schema-cost, and never reads the job", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		let read = 0;
		const out: CiOutcome = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: async () => {
				read++;
				return { gates: [GATE_FILE_SIZE] };
			},
			includeGates: false,
		});
		expect(out.gates).toEqual([]);
		expect(out.gateError).toBeUndefined();
		expect(read).toBe(0);
		expect(calls.some((c) => c.cmd === "bash" && c.args[0] === "-c")).toBe(false);
		// NB: schema-cost is not a spawned script — runSchemaCostCheck is an
		// in-process import, skipped entirely when includeGates=false, so the
		// tools-metrics instrument spawn never happens either.
		expect(out.schemaCost).toBeUndefined();
		expect(calls.some((c) => c.args.includes("tools-metrics") && c.args.includes("--schema-cost")), "did NOT spawn tools-metrics").toBe(false);
	});
});

describe("runLocalCi — oneshot-smoke boot gate wiring", () => {
	// Same scoped helpers as the gates describe above (detect/readPkg defaults).
	const detect = () => mkDetect({ "pkg-a": true }).fn;
	const readPkg = () => mkReadPkg({ "pkg-a": { test: "bun test" } });
	// The gate itself is unit-tested in tests/oneshot-smoke.test.ts; these cover
	// ONLY the recipe wiring: a smoke row lands in `gates` blocking (a FAIL flips
	// overall, unlike the info-only schema-cost), null (not applicable / foreign
	// repoRoot) adds no row, and the fail-closed gateError path skips it.
	const smokePass = { exitCode: 0, verdict: "pass" as const, mode: "fast-only" as const, note: "pass (fast 1.2s)", durationMs: 1200 };
	const smokeFail = {
		exitCode: 1,
		verdict: "fail" as const,
		mode: "fast+canary" as const,
		note: "fail (fast probe: timeout)",
		detail: "BOOT HANG: …",
		durationMs: 90_000,
	};

	test("smoke PASS row lands in gates with its note; overall stays pass", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
			runOneshotSmoke: async () => smokePass,
		});
		const row = out.gates.find((g) => g.name === "oneshot-smoke");
		expect(row?.exitCode).toBe(0);
		expect(row?.note).toBe("pass (fast 1.2s)");
		expect(out.overall).toBe("pass");
	});

	test("smoke FAIL row is BLOCKING — overall fails and the diagnostic is carried", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
			runOneshotSmoke: async () => smokeFail,
		});
		expect(out.overall).toBe("fail");
		const row = out.gates.find((g) => g.name === "oneshot-smoke");
		expect(row?.exitCode).toBe(1);
		expect(row?.detail).toContain("BOOT HANG");
	});

	test("smoke null (not applicable) adds no gates row", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
			runOneshotSmoke: async () => null,
		});
		expect(out.gates.some((g) => g.name === "oneshot-smoke")).toBe(false);
		expect(out.overall).toBe("pass");
	});

	test("default runner at a foreign repoRoot (/repo has no devops package) adds no row", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: fakeGates(),
			// NOTE: no runOneshotSmoke injection — the DEFAULT runs here and must
		// self-select out via the monorepo marker instead of spawning or writing.
		});
		expect(out.gates.map((g) => g.name)).toEqual([GATE_FILE_SIZE.name, GATE_DEPS.name]);
		expect(out.overall).toBe("pass");
	});

	test("gateError (unreadable job) skips the smoke gate too — fail-closed means NO gate ran", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		let smokeCalls = 0;
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: detect(),
			readPkg: readPkg(),
			readGates: async () => ({ gates: [], error: "no `regression-gates` job" }),
			runOneshotSmoke: async () => {
				smokeCalls++;
				return smokePass;
			},
		});
		expect(out.overall).toBe("fail");
		expect(out.gates).toEqual([]);
		expect(smokeCalls).toBe(0);
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

/**
 * The CI matrix as the source of truth for a package's test command.
 *
 * Before this, runLocalCi derived every package's command generically
 * (`bun run test`), which disagrees with CI for a third of the matrix — so
 * run_local_ci could report green on a package whose real CI command would fail.
 * These cases pin the precedence (matrix > package script > nothing), the
 * `bash -c` execution shape the compound rows need, and — against the REAL
 * workflow — that `s2-agent-ext-file2md` gets its `--isolate`.
 */
describe("runLocalCi — the CI matrix is the source of truth for test commands", () => {
	test("a package WITH a matrix row runs that exact command via bash -c, not `bun run test`", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			packages: ["s2-agent-ext-file2md"],
			spawn: fn,
			readPkg: mkReadPkg({ "s2-agent-ext-file2md": { test: "bun test" } }),
			readMatrix: async () => ({ "s2-agent-ext-file2md": "bun test --isolate" }),
			includeGates: false,
		});
		const inPkg = calls.filter((c) => pkgOf(c.cwd) === "s2-agent-ext-file2md");
		expect(inPkg).toContainEqual({
			cmd: "bash",
			args: ["-c", "bun test --isolate"],
			cwd: pkgDir("s2-agent-ext-file2md"),
		});
		// the generic derivation was NOT used.
		expect(inPkg.some((c) => c.cmd === "bun" && c.args[0] === "run" && c.args[1] === "test")).toBe(false);
	});

	test("the outcome records where the command came from", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			packages: ["with-row", "without-row"],
			spawn: fn,
			readPkg: mkReadPkg({ "with-row": { test: "bun test" }, "without-row": { test: "bun test" } }),
			readMatrix: async () => ({ "with-row": "bun test && bun run qa" }),
			includeGates: false,
		});
		const byName = Object.fromEntries(out.packages.map((p) => [p.name, p.test]));
		expect(byName["with-row"]).toMatchObject({ source: "matrix", command: "bun test && bun run qa" });
		expect(byName["without-row"]).toMatchObject({ source: "package-script" });
		expect(byName["without-row"].command).toBeUndefined();
	});

	test("a package with NO matrix row keeps the generic `bun run test` derivation", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-unlisted"],
			spawn: fn,
			readPkg: mkReadPkg({ "pkg-unlisted": { test: "bun test" } }),
			readMatrix: async () => ({ "some-other-pkg": "bun test --isolate" }),
			includeGates: false,
		});
		const inPkg = calls.filter((c) => pkgOf(c.cwd) === "pkg-unlisted");
		expect(inPkg).toContainEqual({ cmd: "bun", args: ["run", "test"], cwd: pkgDir("pkg-unlisted") });
		expect(inPkg.some((c) => c.cmd === "bash")).toBe(false);
	});

	test("a matrix row runs even when the package has NO `test` script", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			packages: ["s2-agent-ext-zai-mcp"],
			spawn: fn,
			// no `test` key — `bun test` discovers *.test.ts without one.
			readPkg: mkReadPkg({ "s2-agent-ext-zai-mcp": { check: "tsc --noEmit" } }),
			readMatrix: async () => ({ "s2-agent-ext-zai-mcp": "bun test" }),
			includeGates: false,
		});
		expect(out.packages[0].test).toMatchObject({ source: "matrix", exitCode: 0 });
		expect(calls).toContainEqual({ cmd: "bash", args: ["-c", "bun test"], cwd: pkgDir("s2-agent-ext-zai-mcp") });
	});

	test("a failing matrix command fails `overall` (it is not a no-op passthrough)", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{ match: (c, a) => c === "bash" && a[0] === "-c", result: { stdout: "", stderr: "boom", exitCode: 1 } },
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-a"],
			spawn: fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			readMatrix: async () => ({ "pkg-a": "bun test --isolate" }),
			includeGates: false,
		});
		expect(out.overall).toBe("fail");
		expect(out.packages[0].test.exitCode).toBe(1);
	});

	test("DEFAULT reader: against the real workflow, file2md gets `bun test --isolate`", async () => {
		// No readMatrix injected → the production path parses this repo's real
		// .github/workflows/ci.yml.disabled. This is the end-to-end proof that a
		// live `run_local_ci` run honors the matrix, not just the injected fake.
		const realRoot = resolve(import.meta.dir, "..", "..", "..");
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: realRoot,
			packages: ["s2-agent-ext-file2md"],
			spawn: fn,
			readPkg: mkReadPkg({ "s2-agent-ext-file2md": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].test).toMatchObject({ source: "matrix", command: "bun test --isolate" });
		expect(
			calls.some((c) => c.cmd === "bash" && c.args[0] === "-c" && c.args[1] === "bun test --isolate"),
		).toBe(true);
		expect(calls.some((c) => c.cmd === "bun" && c.args[0] === "run" && c.args[1] === "test")).toBe(false);
	});
});

// ── ≤5-minute budget + execution model (hardened 2026-08-15) ──────────────────
// USER RULE: a run_local_ci run over ~5 minutes is bad CI. The recipe now (a) tracks
// per-step durations + an explicit budget (default 300 s) and reports overBudget,
// and (b) cuts wall-clock: typechecks run in PARALLEL (tsc --noEmit is read-only),
// and test rows are split so BUILD rows (matrix commands containing `build`) run
// SEQUENTIALLY FIRST — serializing every dist write — before the non-build rows
// run with bounded parallelism (no dist writes in flight during the parallel
// phase → the ci-local.ts "parallel runs race workflow's shared dist/" hazard is
// eliminated by construction).

describe("runLocalCi — ≤5-min budget (hard rule)", () => {
	const base = {
		repoRoot: REPO,
		spawn: mkSpawn([verifyOk()]).fn,
		readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
		readMatrix: async () => ({}),
		includeGates: false,
	};

	test("default budget is 5 minutes and is echoed in the outcome", async () => {
		const out = await runLocalCi({ ...base, packages: ["pkg-a"] });
		expect(out.budgetMs).toBe(300_000);
	});

	test("overBudget=true when elapsed exceeds budgetMs (injectable clock)", async () => {
		// An ADVANCING clock: every now() sample moves time forward 100 ms, so a
		// run that samples the clock ≥2 times racks up elapsed > budget.
		let t = 0;
		const out = await runLocalCi({ ...base, packages: ["pkg-a"], budgetMs: 100, now: () => (t += 100) });
		expect(t).toBeGreaterThan(100); // the recipe actually sampled the clock
		expect(out.overBudget).toBe(true);
		expect(out.overall).toBe("pass"); // budget is advisory, never a merge gate
	});

	test("per-step durations + slowest ranking are reported", async () => {
		const out = await runLocalCi({
			...base,
			packages: ["pkg-a", "pkg-b"],
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", test: "bun test" }, "pkg-b": { test: "bun test" } }),
		});
		for (const p of out.packages) {
			expect(typeof p.test.durationMs).toBe("number");
		}
		const a = out.packages.find((p) => p.name === "pkg-a")!;
		expect(typeof a.typecheck?.durationMs).toBe("number");
		expect(Array.isArray(out.slowest)).toBe(true);
		expect(out.slowest!.length).toBeLessThanOrEqual(5);
	});
});

describe("runLocalCi — execution model (parallel, builder-first)", () => {
	test("BUILD rows run before non-build rows even when listed later", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-pure", "pkg-builder"],
			spawn: fn,
			readPkg: mkReadPkg({ "pkg-pure": { test: "bun test" }, "pkg-builder": { test: "bun test" } }),
			readMatrix: async () => ({ "pkg-pure": "bun test", "pkg-builder": "bun run build && bun test" }),
			includeGates: false,
		});
		const idx = (name: string) =>
			calls.findIndex((c) => c.cmd === "bash" && pkgOf(c.cwd) === name);
		expect(idx("pkg-builder")).toBeGreaterThanOrEqual(0);
		expect(idx("pkg-builder")).toBeLessThan(idx("pkg-pure"));
	});

	test("result order follows the input package order, not execution order", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-pure", "pkg-builder"],
			spawn: fn,
			readPkg: mkReadPkg({ "pkg-pure": { test: "bun test" }, "pkg-builder": { test: "bun test" } }),
			readMatrix: async () => ({ "pkg-pure": "bun test", "pkg-builder": "bun run build && bun test" }),
			includeGates: false,
		});
		expect(out.packages.map((p) => p.name)).toEqual(["pkg-pure", "pkg-builder"]);
	});

	test("non-build test rows run with bounded concurrency", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		let inFlight = 0;
		let maxInFlight = 0;
		const tracking: SpawnFn = async (cmd, args, options) => {
			// these packages have no matrix row → tests spawn as `bun run test`.
			if (cmd === "bun" && args[0] === "run" && args[1] === "test") {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
			}
			return fn(cmd, args, options);
		};
		await runLocalCi({
			repoRoot: REPO,
			packages: ["p1", "p2", "p3", "p4", "p5", "p6"],
			spawn: tracking,
			readPkg: mkReadPkg(Object.fromEntries(["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => [n, { test: "bun test" }]))),
			readMatrix: async () => ({}),
			includeGates: false,
			concurrency: 2,
		});
		expect(maxInFlight).toBeGreaterThan(1); // actually parallel
		expect(maxInFlight).toBeLessThanOrEqual(2); // bounded
	});

	test("typechecks of multiple packages run in parallel (read-only tsc)", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		let inFlight = 0;
		let maxInFlight = 0;
		const tracking: SpawnFn = async (cmd, args, options) => {
			if (cmd === "bun" && args[0] === "run" && args[1] === "typecheck") {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
			}
			return fn(cmd, args, options);
		};
		await runLocalCi({
			repoRoot: REPO,
			packages: ["p1", "p2", "p3", "p4"],
			spawn: tracking,
			readPkg: mkReadPkg(Object.fromEntries(["p1", "p2", "p3", "p4"].map((n) => [n, { typecheck: "tsc --noEmit", test: "bun test" }]))),
			readMatrix: async () => ({}),
			includeGates: false,
			concurrency: 3,
		});
		expect(maxInFlight).toBeGreaterThan(1);
		// The read-only phase runs concurrency + 2 wide (extra width can only
		// cost CPU, never correctness — see the 3a comment in ci-recipe.ts).
		expect(maxInFlight).toBeLessThanOrEqual(5);
	});
});

describe("runLocalCi — link-breaker isolation (s2-agent runs sequential-first)", () => {
	test("s2-agent's test row runs BEFORE non-build parallel rows even when listed last", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			packages: ["pkg-a", "s2-agent"],
			spawn: fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" }, "s2-agent": { test: "bun test" } }),
			readMatrix: async () => ({ "pkg-a": "bun test", "s2-agent": "bun test" }),
			includeGates: false,
		});
		const idx = (name: string) =>
			calls.findIndex((c) => (c.cmd === "bash" || (c.cmd === "bun" && c.args[1] === "test")) && pkgOf(c.cwd) === name);
		expect(idx("s2-agent")).toBeGreaterThanOrEqual(0);
		expect(idx("s2-agent")).toBeLessThan(idx("pkg-a"));
	});

	test("the heal (relink dangling @repo links) repairs the workspace — only when s2-agent's suite ran", async () => {
		// The heal is in-process fs (was a `bash -c` spawn), so the contract is
		// asserted on REAL link state, not on a recorded spawn: a dangling
		// @repo/* symlink is rewritten to bun's `../../<dir>` form, a healthy
		// link is left alone, and none of it happens when s2-agent (the sole
		// link-breaker) did not run.
		const mkRepo = () => {
			const tmp = mkdtempSync(join(tmpdir(), "ci-heal-test-"));
			const repoDir = join(tmp, "bun-apps", "node_modules", "@repo");
			mkdirSync(repoDir, { recursive: true });
			// The real package dir the healed link points at (bun's own
			// `../../<dir>` form resolves to bun-apps/<dir>).
			mkdirSync(join(tmp, "bun-apps", "dangling-pkg"), { recursive: true });
			// Dangling: the Bun-runtime rewrite form, pointing at a depth where
			// nothing exists.
			symlinkSync("../../bun-apps/does-not-exist", join(repoDir, "dangling-pkg"), "dir");
			// Healthy: resolves to a real directory (the tmp root).
			symlinkSync(tmp, join(repoDir, "live-pkg"), "dir");
			return { tmp, repoDir };
		};

		const { fn } = mkSpawn([verifyOk()]);
		const { tmp, repoDir } = mkRepo();
		try {
			await runLocalCi({
				repoRoot: tmp,
				packages: ["pkg-a", "s2-agent"],
				spawn: fn,
				readPkg: mkReadPkg({ "pkg-a": { test: "bun test" }, "s2-agent": { test: "bun test" } }),
				readMatrix: async () => ({ "pkg-a": "bun test", "s2-agent": "bun test" }),
				includeGates: false,
			});
			// Dangling link healed to bun's own relative form…
			expect(readlinkSync(join(repoDir, "dangling-pkg"))).toBe("../../dangling-pkg");
			// …and now resolves; the healthy link is untouched.
			expect(existsSync(join(repoDir, "dangling-pkg"))).toBe(true);
			expect(readlinkSync(join(repoDir, "live-pkg"))).toBe(tmp);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}

		// …and NOT when s2-agent is absent (its suite is the sole link-breaker).
		const { fn: fn2 } = mkSpawn([verifyOk()]);
		const { tmp: tmp2, repoDir: repoDir2 } = mkRepo();
		try {
			await runLocalCi({
				repoRoot: tmp2,
				packages: ["pkg-a"],
				spawn: fn2,
				readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
				readMatrix: async () => ({ "pkg-a": "bun test" }),
				includeGates: false,
			});
			expect(readlinkSync(join(repoDir2, "dangling-pkg"))).toBe("../../bun-apps/does-not-exist");
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	});
});

// ─── Hang containment (RCA 2026-08-15) ───────────────────────────────────────
// A `bun test --isolate` child outlived its parent and spun at 100% CPU for six
// hours; every later run in that worktree hung, because the spawn layer had no
// timeout and `Bun.readableStreamToText` waits for EOF on a pipe a live
// descendant is still holding. `budgetMs` could not help — it is measured after
// the run and never kills.

/** Recording spawn that ALSO captures each call's timeoutMs. */
function mkTimedSpawn(
	responses: Array<{ match: (cmd: string, args: string[], cwd: string) => boolean; result: SpawnResult }> = [],
) {
	const calls: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs?: number }> = [];
	const fn: SpawnFn = async (cmd, args, options) => {
		calls.push({ cmd, args, cwd: options?.cwd ?? "", timeoutMs: options?.timeoutMs });
		return responses.find((r) => r.match(cmd, args, options?.cwd ?? ""))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

describe("runLocalCi — hang containment", () => {
	test("every package typecheck + test spawn carries a hard timeoutMs", async () => {
		const { fn, calls } = mkTimedSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test", typecheck: "tsc --noEmit" } }),
			includeGates: false,
			perCommandTimeoutMs: 1234,
		});
		const perPackage = calls.filter((c) => c.cwd === pkgDir("pkg-a"));
		expect(perPackage.length).toBeGreaterThanOrEqual(2);
		for (const c of perPackage) expect(c.timeoutMs).toBe(1234);
	});

	test("default cap is applied when the caller sets none", async () => {
		const { fn, calls } = mkTimedSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		const testCall = calls.find((c) => c.cwd === pkgDir("pkg-a") && c.args[1] === "test");
		// 180s: sized against s2-agent's ~100-111s row (see perCommandTimeoutMs
		// doc in ci-recipe.ts) so the cap only ever catches a HANG.
		expect(testCall?.timeoutMs).toBe(180_000);
	});

	test("a timed-out package (exit 124) fails overall AND says it hung, not that it failed", async () => {
		const { fn } = mkTimedSpawn([
			verifyOk(),
			{
				match: (c, a, cwd) => c === "bun" && a[1] === "test" && pkgOf(cwd) === "pkg-a",
				result: { stdout: "", stderr: "", exitCode: 124 },
			},
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.overall).toBe("fail");
		expect(out.packages[0].test.exitCode).toBe(124);
		expect(out.packages[0].test.note).toMatch(/HUNG/);
	});
});

describe("runLocalCi — each package's test runs exactly once", () => {
	// s2-agent is pulled into the SEQUENTIAL-first phase by name (it rewrites
	// @repo/* symlinks, so it must not run beside anything). The parallel phase
	// used to select `!p.builds`, which is true for s2-agent — so its whole suite
	// ran a second time, ~26s wasted and a symlink-rewrite race re-opened while
	// other packages were resolving @repo/* concurrently.
	test("s2-agent is not re-run by the parallel phase", async () => {
		const { fn, calls } = mkTimedSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "s2-agent": true, "pkg-b": true }).fn,
			readPkg: mkReadPkg({ "s2-agent": { test: "bun test" }, "pkg-b": { test: "bun test" } }),
			includeGates: false,
		});
		const runsFor = (pkg: string) =>
			calls.filter((c) => pkgOf(c.cwd) === pkg && c.cmd === "bun" && c.args[0] === "run" && c.args[1] === "test").length;
		expect(runsFor("s2-agent")).toBe(1);
		expect(runsFor("pkg-b")).toBe(1);
	});

	test("a build-bearing row also runs exactly once", async () => {
		const { fn, calls } = mkTimedSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun run build && bun test" } }),
			includeGates: false,
		});
		expect(calls.filter((c) => pkgOf(c.cwd) === "pkg-a" && c.args[1] === "test").length).toBe(1);
	});
});

/**
 * Failure DETAIL — the captured output tail on a red row.
 *
 * Before this, every spawn's stdout/stderr was discarded and a failing package
 * or gate reported a bare exit code. A `check_main_health` run that says
 * `s2-agent test.exitCode = 1` and nothing else cannot be acted on: the reader
 * has to re-run the suite by hand to learn anything, and an intermittent
 * failure that passes on the re-run gets written off as a flake with no
 * evidence either way. That is what happened on 2026-08-18.
 *
 * The invariant these pin: a NON-ZERO row carries a tail, a ZERO row carries
 * NO `detail` key at all (not `undefined` — absent), so green payloads and the
 * `toEqual` assertions above are byte-identical to before.
 */
describe("runLocalCi — failure detail", () => {
	const failWith = (stdout: string, stderr: string) => ({
		match: (c: string, a: string[]) => c === "bun" && a[0] === "run" && a[1] === "test",
		result: { stdout, stderr, exitCode: 1 },
	});

	test("a failed package test carries the stderr AND stdout tail", async () => {
		const { fn } = mkSpawn([verifyOk(), failWith("running 3 tests", "error: expected 1, got 9")]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.overall).toBe("fail");
		const detail = out.packages[0].test.detail;
		expect(detail).toContain("error: expected 1, got 9");
		expect(detail).toContain("running 3 tests");
		// stderr first — `bun test` puts the failure summary there.
		expect(detail!.indexOf("stderr")).toBeLessThan(detail!.indexOf("stdout"));
	});

	test("a PASSING package has no `detail` key at all", async () => {
		const { fn } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		expect(out.overall).toBe("pass");
		expect("detail" in out.packages[0].test).toBe(false);
	});

	test("a failed typecheck carries its own tail", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{
				match: (c: string, a: string[]) => c === "bun" && a[0] === "run" && a[1] === "typecheck",
				result: { stdout: "src/x.ts(3,1): error TS2304: Cannot find name 'foo'.", stderr: "", exitCode: 2 },
			},
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { typecheck: "tsc --noEmit", test: "bun test" } }),
			includeGates: false,
		});
		expect(out.packages[0].typecheck!.exitCode).toBe(2);
		expect(out.packages[0].typecheck!.detail).toContain("TS2304");
	});

	test("a failed GATE carries a tail — the field its doc-comment always promised", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			{
				match: (c: string, a: string[]) => c === "bash" && a[1] === GATE_DEPS.run,
				result: { stdout: "", stderr: "dep-guard: hermes -> hub edge reintroduced", exitCode: 1 },
			},
		]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			readGates: fakeGates(),
			runOneshotSmoke: async () => null,
		});
		const gate = out.gates.find((g) => g.name === GATE_DEPS.name)!;
		expect(gate.exitCode).toBe(1);
		expect(gate.detail).toContain("hermes -> hub edge reintroduced");
		// the gate that passed stays bare.
		expect("detail" in out.gates.find((g) => g.name === GATE_FILE_SIZE.name)!).toBe(false);
	});

	test("the tail is bounded to the LAST 40 lines", async () => {
		const noisy = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
		const { fn } = mkSpawn([verifyOk(), failWith("", noisy)]);
		const out = await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			detectChangedPackages: mkDetect({ "pkg-a": true }).fn,
			readPkg: mkReadPkg({ "pkg-a": { test: "bun test" } }),
			includeGates: false,
		});
		const detail = out.packages[0].test.detail!;
		expect(detail).toContain("line-199");
		expect(detail).toContain("line-160");
		expect(detail).not.toContain("line-159");
	});
});

describe("runLocalCi — change-triggered deploy-e2e gate", () => {
	/** git diff --name-only responder. */
	const diffFiles = (files: string[]) => ({
		match: (c: string, a: string[]) =>
			c === "git" && a[0] === "diff" && a[1] === "--name-only",
		result: { stdout: `${files.join("\n")}\n`, stderr: "", exitCode: 0 },
	});
	const baseOpts = {
		repoRoot: REPO,
		readPkg: mkReadPkg({}),
		detectChangedPackages: mkDetect({}).fn,
		readGates: fakeGates([]),
		readMatrix: async () => ({}),
	};

	test("sensitive file changed → gate runs with PI_AGENT_E2E command in s2-agent cwd", async () => {
		const { fn, calls } = mkSpawn([
			verifyOk(),
			diffFiles(["bun-apps/s2-agent/src/patches/index.ts"]),
		]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		const gate = out.gates.find((g) => g.name.includes("change-triggered"));
		expect(gate).toBeDefined();
		expect(gate!.exitCode).toBe(0);
		const run = calls.find(
			(c) => c.cmd === "bash" && c.args[1]?.includes("PI_AGENT_E2E=1 bun test"),
		);
		expect(run).toBeDefined();
		expect(run!.cwd).toBe(`${REPO}/bun-apps/s2-agent`);
		expect(out.overall).toBe("pass");
	});

	test("unrelated files only → no gate, no deploy-e2e spawn", async () => {
		const { fn, calls } = mkSpawn([
			verifyOk(),
			diffFiles(["bun-apps/gui-movie-director/src/App.tsx"]),
		]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		expect(out.gates.find((g) => g.name.includes("change-triggered"))).toBeUndefined();
		expect(calls.find((c) => c.args[1]?.includes("PI_AGENT_E2E=1"))).toBeUndefined();
	});

	test("empty diff (no changes vs base) → no gate", async () => {
		const { fn } = mkSpawn([verifyOk(), diffFiles([])]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		expect(out.gates.find((g) => g.name.includes("change-triggered"))).toBeUndefined();
	});

	test("failed deploy-e2e run fails overall", async () => {
		const { fn } = mkSpawn([
			verifyOk(),
			diffFiles(["s2-agent.sh"]),
			{
				match: (c: string, a: string[]) =>
					c === "bash" && a[1]?.includes("PI_AGENT_E2E=1 bun test"),
				result: { stdout: "", stderr: "1 fail", exitCode: 1 },
			},
		]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		expect(out.overall).toBe("fail");
		expect(out.gates.find((g) => g.name.includes("change-triggered"))!.exitCode).toBe(1);
	});

	test("git diff itself fails → gate skipped, overall still pass (unconditional deploy gates already ran)", async () => {
		const { fn, calls } = mkSpawn([
			verifyOk(),
			{
				match: (c: string, a: string[]) =>
					c === "git" && a[0] === "diff" && a[1] === "--name-only",
				result: { stdout: "", stderr: "fatal: bad object", exitCode: 128 },
			},
		]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		expect(out.gates.find((g) => g.name.includes("change-triggered"))).toBeUndefined();
		expect(calls.find((c) => c.args[1]?.includes("PI_AGENT_E2E=1"))).toBeUndefined();
		expect(out.overall).toBe("pass");
	});
});

describe("runLocalCi — base-ref default follows remoteName", () => {
	test("default baseRef is <remoteName>/main when provided", async () => {
		const { fn, calls } = mkSpawn([verifyOk("upstream/main")]);
		const detect = mkDetect({});
		await runLocalCi({
			repoRoot: REPO,
			spawn: fn,
			remoteName: "upstream",
			detectChangedPackages: detect.fn,
			readPkg: mkReadPkg({}),
			includeGates: false,
		});
		const verify = calls.find((c) => c.args.includes("--verify"));
		expect(verify?.args).toContain("upstream/main");
		expect(detect.calls[0].baseRef).toBe("upstream/main");
	});
});
