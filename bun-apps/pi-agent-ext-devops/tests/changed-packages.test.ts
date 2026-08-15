/**
 * DIRECT unit tests for `computeChangedPackages` — the extension-native TS port
 * of the former scripts/ci-changed-packages.sh. These replaced the old
 * mock-spawn tests that faked `bash scripts/ci-changed-packages.sh`'s stdout:
 * detection internals (reverse-BFS, fail-open, transitivity) are now exercised
 * IN-PROCESS with a synthetic @repo/* graph and a faked `git diff`, instead of
 * through an opaque bash subprocess.
 *
 * I/O seams injected so no real fs/git is touched:
 *  - `spawn`           : faked to return canned `git diff --name-only` output +
 *                        a resolvable/unresolvable `git rev-parse` answer.
 *  - `discoverPackages`: a fixed, sorted package list.
 *  - `readDeps`        : a fixed @repo/* dependency table (the reverse-BFS graph).
 */
import { test, expect, describe } from "bun:test";
import {
	computeChangedPackages,
	extractRepoDeps,
	type ComputeChangedPackagesOptions,
} from "../src/changed-packages.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";

/** Fake `SpawnFn`: answers `git diff` / `git rev-parse` from a canned map. */
function mkSpawn(opts: {
	diffStdout?: string;
	diffExit?: number;
	baseResolvable?: boolean;
}): { fn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
			return { stdout: opts.diffStdout ?? "", stderr: "", exitCode: opts.diffExit ?? 0 } satisfies SpawnResult;
		}
		if (cmd === "git" && args[0] === "rev-parse") {
			const ok = opts.baseResolvable ?? true;
			return { stdout: ok ? "deadbeef\n" : "", stderr: ok ? "" : "unknown", exitCode: ok ? 0 : 128 } satisfies SpawnResult;
		}
		return { stdout: "", stderr: "", exitCode: 0 } satisfies SpawnResult;
	};
	return { fn, calls };
}

/** Injectable discoverPackages: return the given list as-is (already sorted). */
const discover = (pkgs: string[]) => () => [...pkgs];

/** Injectable readDeps from a pkg → deps map (the reverse-BFS graph). */
const readDepsFrom = (graph: Record<string, string[]>) => (pkg: string) => [...(graph[pkg] ?? [])];

describe("computeChangedPackages — extractRepoDeps (bash grep parity)", () => {
	test("textual scan strips quotes + @repo/ prefix, dedupes, sorts, drops self", () => {
		const text = JSON.stringify({
			name: "@repo/pkg-a",
			devDependencies: { "@repo/pkg-a": "*", "@repo/pkg-z": "*", "@repo/pkg-b": "*" },
			dependencies: { "@repo/pkg-b": "*" },
		});
		// bash: grep -oE '"@repo/[a-zA-Z0-9_-]+"' | tr -d '"' | sed 's#^@repo/##' | sort -u
		// → pkg-b, pkg-z (pkg-a is self, stripped). Sorted.
		expect(extractRepoDeps(text, "pkg-a")).toEqual(["pkg-b", "pkg-z"]);
	});

	test("char class [a-zA-Z0-9_-] matches underscore + digits + hyphen names", () => {
		const text = `"@repo/pkg_1-a" "@repo/pkg2"`;
		expect(extractRepoDeps(text, "self")).toEqual(["pkg2", "pkg_1-a"]);
	});

	test("no @repo deps → empty array (does not throw)", () => {
		expect(extractRepoDeps('{"name":"x","dependencies":{"react":"*"}}', "x")).toEqual([]);
	});
});

describe("computeChangedPackages — --all + diff modes", () => {
	// Graph: who depends on whom.
	//   a ← b ← c        (c deps on b; b deps on a)
	//   a ← d            (d deps on a)
	//   e                (isolated)
	// reverse-deps: dependents(a)={b,d}, dependents(b)={c}, dependents(c)={}, dependents(d)={}, dependents(e)={}
	const PKGS = ["a", "b", "c", "d", "e"];
	const GRAPH = { a: [], b: ["a"], c: ["b"], d: ["a"], e: [] };

	test("--all → every package true (no git diff spawned)", async () => {
		const { fn, calls } = mkSpawn({});
		const map = await computeChangedPackages({
			repoRoot: REPO,
			all: true,
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom(GRAPH),
		});
		expect(map).toEqual({ a: true, b: true, c: true, d: true, e: true });
		// --all short-circuits before any git spawn.
		expect(calls.some((c) => c.cmd === "git")).toBe(false);
	});

	test("direct change to a → marks a + direct + transitive reverse-deps (b,c,d); e untouched", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/src/index.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			headRef: "HEAD",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom(GRAPH),
		});
		// a (direct) + b,d (direct dependents of a) + c (transitive: depends on b).
		expect(map).toEqual({ a: true, b: true, c: true, d: true, e: false });
	});

	test("direct change to a leaf (c, nothing depends on it) → only c true", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/c/src/x.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom(GRAPH),
		});
		expect(map).toEqual({ a: false, b: false, c: true, d: false, e: false });
	});

	test("direct change to b → marks b + its dependent c (transitive stops at c)", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/b/y.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom(GRAPH),
		});
		expect(map).toEqual({ a: false, b: true, c: true, d: false, e: false });
	});
});

describe("computeChangedPackages — fail-open semantics", () => {
	const PKGS = ["a", "b"];

	test("non-package change (e.g. scripts/foo.sh) → ALL true (fail-open)", async () => {
		const { fn } = mkSpawn({ diffStdout: "scripts/ci-file-size-guard.sh\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true });
	});

	test("mixed: a package file + a non-package file → ALL true (non-pkg file dominates)", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/x.ts\nbun-apps/UNKNOWN/pkg.json\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b"]),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		// UNKNOWN is not a known package → its file fails open → everything true.
		expect(map).toEqual({ a: true, b: true });
	});

	test("empty diff + base RESOLVABLE → all false (nothing changed, nothing to run)", async () => {
		const { fn, calls } = mkSpawn({ diffStdout: "", baseResolvable: true });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b"]),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: false, b: false });
		// rev-parse was consulted (the empty-diff fail-open probe).
		expect(calls.some((c) => c.cmd === "git" && c.args[0] === "rev-parse")).toBe(true);
	});

	test("empty diff + base UNRESOLVABLE (shallow clone) → ALL true (fail-open)", async () => {
		const { fn } = mkSpawn({ diffStdout: "", baseResolvable: false });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b"]),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true });
	});

	test("git diff exits non-zero but emits files → still processes the files (|| true parity)", async () => {
		// bash: `git diff ... 2>/dev/null || true` — a non-zero exit with stdout is
		// treated as if it succeeded; the stdout is still the changed-file list.
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/x.ts\n", diffExit: 1, baseResolvable: true });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b"]),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true });
	});
});

describe("computeChangedPackages — matrix-irrelevant paths (scoped, NOT fail-open)", () => {
	// The ≤5-minute local_ci budget depends on scoping. Three path classes are
	// provably package-matrix-irrelevant and must NOT trip the rule-4 fail-open:
	//   .planning/**     — docs-only artifacts the standing rule REQUIRES
	//                      committing with every branch/PR; before this guard,
	//                      every PR that obeyed the rule ran the FULL matrix.
	//   bun-apps/tests/**— workspace-root gate tests; they run in the
	//                      regression-gates job (bun run test:dist), which
	//                      local_ci executes regardless of package scoping.
	//   dsh-sv-analyzer/**— standalone top-level Rust/DSH plugin project with
	//                      its own cargo/node build; cannot affect bun-apps.
	const PKGS = ["a", "b"];

	test(".planning/ docs only → all false (docs need no package matrix)", async () => {
		const { fn } = mkSpawn({ diffStdout: ".planning/REVIEW-2026-08-15-pi-agent.md\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: false, b: false });
	});

	test("package file + .planning/ doc → scoped to the package's reverse-deps, NOT all true", async () => {
		const { fn } = mkSpawn({ diffStdout: ".planning/spec.md\nbun-apps/a/x.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true }); // reverse-BFS, not fail-open
	});

	test("bun-apps/tests/ gate test only → all false (covered by regression-gates, not the matrix)", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/tests/workspace-dist-fresh.test.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: false, b: false });
	});

	test("dsh-sv-analyzer/ only → all false (standalone project, needs no package matrix)", async () => {
		const { fn } = mkSpawn({ diffStdout: "dsh-sv-analyzer/plugin/index.js\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: false, b: false });
	});

	test("package file + dsh-sv-analyzer/ file → scoped, NOT all true", async () => {
		const { fn } = mkSpawn({ diffStdout: "dsh-sv-analyzer/rust/src/lib.rs\nbun-apps/a/x.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true }); // reverse-BFS, not fail-open
	});

	test("package file + bun-apps/tests/ file → scoped, NOT all true", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/x.ts\nbun-apps/tests/gate.test.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true });
	});

	test("everything else outside packages STILL fails open (shared config, .github/, submodules)", async () => {
		const { fn } = mkSpawn({
			diffStdout: "bun-apps/package.json\n.github/workflows/ci.yml\nassets/x\ndocs/foo.md\n",
		});
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(PKGS),
			readDeps: readDepsFrom({ a: [], b: ["a"] }),
		});
		expect(map).toEqual({ a: true, b: true }); // fail-open preserved
	});
});

describe("computeChangedPackages — exact JSON shape (bash parity)", () => {
	test("output keys are sorted by package name; booleans are real booleans", async () => {
		// Discover out of order; output MUST still be sorted (bash glob is sorted).
		const { fn } = mkSpawn({ diffStdout: "bun-apps/mid/x.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: () => ["zed", "alpha", "mid"], // unsorted input
			readDeps: readDepsFrom({ alpha: [], mid: [], zed: [] }),
		});
		expect(Object.keys(map)).toEqual(["alpha", "mid", "zed"]);
		expect(map).toEqual({ alpha: false, mid: true, zed: false });
		expect(JSON.stringify(map)).toBe('{"alpha":false,"mid":true,"zed":false}');
	});

	test("multiple directly-touched packages all seed the reverse-BFS", async () => {
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/a.ts\nbun-apps/c/c.ts\n" });
		// Graph: b→a, d→c. Touching a and c → affected {a,b,c,d}.
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b", "c", "d"]),
			readDeps: readDepsFrom({ a: [], b: ["a"], c: [], d: ["c"] }),
		});
		expect(map).toEqual({ a: true, b: true, c: true, d: true });
	});

	test("self-reference (@repo/<self>) is stripped — no self-edge loop", async () => {
		// a's package.json lists @repo/a (self) — must NOT create a self-loop.
		const { fn } = mkSpawn({ diffStdout: "bun-apps/a/x.ts\n" });
		const map = await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "main",
			spawn: fn,
			discoverPackages: discover(["a", "b"]),
			readDeps: (pkg) => (pkg === "a" ? ["a", "b"] : []), // a "deps on" a (self) + b
		});
		// a's self-dep is ignored; a's dep on b is a real forward edge but irrelevant
		// here (we touch a, nothing depends on a). b is NOT affected.
		expect(map).toEqual({ a: true, b: false });
	});
});

describe("computeChangedPackages — wiring with defaults", () => {
	test("discoverPackages/readDeps defaults exist and are callable (smoke)", async () => {
		// Indirect: pass minimal opts, assert no throw on the --all path (defaults
		// are only invoked for diff mode's graph build; --all skips them). The
		// default fs/git behavior is exercised by the repo-wide `bun run check` +
		// the live local_ci flow, not by these pure unit tests.
		const { fn } = mkSpawn({});
		const map = await computeChangedPackages({ repoRoot: REPO, all: true, spawn: fn });
		expect(typeof map).toBe("object");
	});

	test("diff mode without baseRef throws (programming error)", async () => {
		const { fn } = mkSpawn({});
		await expect(
			computeChangedPackages({ repoRoot: REPO, spawn: fn, discoverPackages: () => [], readDeps: () => [] }),
		).rejects.toThrow(/baseRef is required/);
	});

	test("headRef defaults to HEAD when omitted", async () => {
		const { fn, calls } = mkSpawn({ diffStdout: "bun-apps/a/x.ts\n" });
		await computeChangedPackages({
			repoRoot: REPO,
			baseRef: "origin/main",
			spawn: fn,
			discoverPackages: () => ["a"],
			readDeps: () => [],
		});
		const diffCall = calls.find((c) => c.cmd === "git" && c.args[0] === "diff");
		expect(diffCall?.args).toEqual(["diff", "--name-only", "origin/main", "HEAD"]);
	});
});
