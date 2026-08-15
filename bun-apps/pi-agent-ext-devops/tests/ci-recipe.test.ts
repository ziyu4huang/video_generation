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
import { LOCAL_ONLY_AUDITS } from "../src/ci-gates.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { ComputeChangedPackagesOptions, ChangedPackagesMap } from "../src/changed-packages.js";
import { resolve } from "node:path";

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

describe("runLocalCi — gates come from the workflow, not a hand-written list", () => {
	const detect = () => mkDetect({ "pkg-a": true }).fn;
	const readPkg = () => mkReadPkg({ "pkg-a": { test: "bun test" } });

	test("runs EVERY gate the reader returns, as a shell command in the gate's own cwd", async () => {
		// The regression this pins: the old code ran two hardcoded files, so the
		// eight `bun run test:*` guards in the job — the ones await_pr_merge is
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
 * local_ci could report green on a package whose real CI command would fail.
 * These cases pin the precedence (matrix > package script > nothing), the
 * `bash -c` execution shape the compound rows need, and — against the REAL
 * workflow — that `pi-agent-ext-file2md` gets its `--isolate`.
 */
describe("runLocalCi — the CI matrix is the source of truth for test commands", () => {
	test("a package WITH a matrix row runs that exact command via bash -c, not `bun run test`", async () => {
		const { fn, calls } = mkSpawn([verifyOk()]);
		await runLocalCi({
			repoRoot: REPO,
			packages: ["pi-agent-ext-file2md"],
			spawn: fn,
			readPkg: mkReadPkg({ "pi-agent-ext-file2md": { test: "bun test" } }),
			readMatrix: async () => ({ "pi-agent-ext-file2md": "bun test --isolate" }),
			includeGates: false,
		});
		const inPkg = calls.filter((c) => pkgOf(c.cwd) === "pi-agent-ext-file2md");
		expect(inPkg).toContainEqual({
			cmd: "bash",
			args: ["-c", "bun test --isolate"],
			cwd: pkgDir("pi-agent-ext-file2md"),
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
			packages: ["pi-agent-ext-zai-mcp"],
			spawn: fn,
			// no `test` key — `bun test` discovers *.test.ts without one.
			readPkg: mkReadPkg({ "pi-agent-ext-zai-mcp": { check: "tsc --noEmit" } }),
			readMatrix: async () => ({ "pi-agent-ext-zai-mcp": "bun test" }),
			includeGates: false,
		});
		expect(out.packages[0].test).toMatchObject({ source: "matrix", exitCode: 0 });
		expect(calls).toContainEqual({ cmd: "bash", args: ["-c", "bun test"], cwd: pkgDir("pi-agent-ext-zai-mcp") });
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
		// live `local_ci` run honors the matrix, not just the injected fake.
		const realRoot = resolve(import.meta.dir, "..", "..", "..");
		const { fn, calls } = mkSpawn([verifyOk()]);
		const out = await runLocalCi({
			repoRoot: realRoot,
			packages: ["pi-agent-ext-file2md"],
			spawn: fn,
			readPkg: mkReadPkg({ "pi-agent-ext-file2md": { test: "bun test" } }),
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
// USER RULE: a local_ci run over ~5 minutes is bad CI. The recipe now (a) tracks
// per-step durations + an explicit budget (default 300 s) and reports overBudget,
// and (b) cuts wall-clock: typechecks run in PARALLEL (tsc --noEmit is read-only),
// and test rows are split so BUILD rows (matrix commands containing `build`) run
// SEQUENTIALLY FIRST — serializing every dist write — before the non-build rows
// run with bounded parallelism (no dist writes in flight during the parallel
// phase → the ci-local.sh "parallel runs race workflow's shared dist/" hazard is
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
		expect(maxInFlight).toBeLessThanOrEqual(3);
	});
});
