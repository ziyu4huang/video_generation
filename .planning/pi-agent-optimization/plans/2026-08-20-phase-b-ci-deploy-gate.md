# Phase B — change-triggered local_ci deploy-e2e gate: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last CI blind spot: the `PI_AGENT_E2E` bundle-mode assertions (patch application in the built bundle, SOURCE-layer extension loading) run in local_ci — but only when the change set touches deploy-sensitive paths.

**Architecture:** A pure decision module (`ci-deploy-gate.ts`: pattern list + `shouldRunDeployE2e`) is wired into `runLocalCi`'s gate section as a hand-added, change-triggered gate — same pattern as `oneshot-smoke`. Changed files come from a `git diff --name-only` through the injectable `SpawnFn` seam, so the whole flow stays testable with the existing recording-fake pattern. One `bun test` invocation covers both files, so the existing per-process `ensureBundle()` cache means ONE bundle build.

**Tech Stack:** TypeScript + `bun:test`, devops package pure-recipe style (injectable `SpawnFn`).

**Spec:** `.planning/pi-agent-optimization/spec.md` — Phase B section, as amended by Task 3 of this plan (ground-truth correction: see "Spec premise correction" below).

## Spec premise correction (ground truth, verified 2026-08-20)

The spec's Phase B was written from an exploration report claiming local_ci runs
"ZERO deploy e2e". Ground truth (observed gate list of a live local_ci run):
the workflow-derived gate suite ALREADY runs `Deploy-artifact guard (bundle +
exe + snapshot)` (scripts/check-deploy-artifacts.sh, ci.yml.disabled:696) and
`Deploy-sh L1 e2e` (check-deploy-sh-e2e.sh, :706) on EVERY run. The real gap is
narrower: the `PI_AGENT_E2E`-gated tests — e2e-patches (every PATCH_TABLE entry
reports applied in bundle mode) and e2e-extensions' SOURCE blocks (doctor
--smoke anti-silent-no-op, >4 KB module load, lazy `-e` splice) — never run in
local_ci; those are exactly the tiers that catch the #1305 regression class
(harness literal drift). Additionally, spec item "shared bundle build:
ensureBundle() gets a per-process cache" is MOOT — the cache already exists
(e2e-harness.ts:54-62, `bundlePromise`); a single `bun test` process covering
both files builds once. The DEPLOY 4-cwd matrix stays opt-out (needs
PI_AGENT_E2E_DEPLOY; too slow for local_ci), unchanged from the spec's intent.

## Global Constraints

- Written output (docs, comments, commits, file content) is English.
- Never top-level `cd` — use `( cd <dir> && … )`, `--cwd`, or absolute paths.
- `runLocalCi` stays PURE: no direct filesystem/git access — every process goes
  through the injectable `SpawnFn` seam (src/spawn.ts).
- Gate suite stays derived from the workflow; this gate is hand-added beside it
  (same precedent as oneshot-smoke, ci-recipe.ts:561-585).
- The ≤5-minute budget rule: this gate adds ~15-25s ONLY on triggering runs,
  zero on all others. `overall` must remain honest — a failed gate run fails
  the outcome.
- Tests: devops canonical `bun run test`; pi-agent untouched except none.
- Git phases through the devops CLI chain (`prepare-cli`, `local-ci-cli`,
  `pr-finish-cli`), branch from `origin/main` before the first commit.

---

### Task 1: Pure decision module `ci-deploy-gate.ts` (TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-devops/src/ci-deploy-gate.ts`
- Test: `bun-apps/pi-agent-ext-devops/tests/ci-deploy-gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Task 2):
  - `DEPLOY_SENSITIVE_PATTERNS: readonly string[]`
  - `DEPLOY_E2E_COMMAND: string` — `"PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts"`
  - `DEPLOY_E2E_GATE_NAME: string` — `"Deploy e2e — PI_AGENT_E2E bundle assertions (change-triggered)"`
  - `shouldRunDeployE2e(changedFiles: string[]): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * Unit tests for the change-triggered deploy-e2e decision — the pure half of
 * local_ci's PI_AGENT_E2E gate. Pattern list + predicate, no fs/git: the
 * recipe feeds it `git diff --name-only` output (see ci-recipe tests).
 */
import { test, expect, describe } from "bun:test";
import {
	DEPLOY_E2E_COMMAND,
	DEPLOY_SENSITIVE_PATTERNS,
	shouldRunDeployE2e,
} from "../src/ci-deploy-gate.js";

describe("shouldRunDeployE2e", () => {
	test("empty change set → no trigger", () => {
		expect(shouldRunDeployE2e([])).toBe(false);
	});
	test("unrelated files → no trigger", () => {
		expect(
			shouldRunDeployE2e([
				"bun-apps/gui-movie-director/src/App.tsx",
				"python/mlx-movie-director/app/run.py",
				"README.md",
			]),
		).toBe(false);
	});
	test("every sensitive pattern triggers", () => {
		for (const p of DEPLOY_SENSITIVE_PATTERNS) {
			expect(shouldRunDeployE2e([`some/other/file.ts`, `${p}x`])).toBe(true);
		}
	});
	test("patterns match at any depth position (prefix-substring)", () => {
		// repo-relative diff lines look like "bun-apps/pi-agent/run.sh"
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/run.sh"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/src/patches/index.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent-ext-devops/scripts/deploy.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["pi-agent.sh"])).toBe(true);
	});
	test("no false positives from similar names", () => {
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/src/cli/sessions/shared.ts"])).toBe(false);
		expect(shouldRunDeployE2e(["docs/pi-agent.sh.md"])).toBe(false);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent-ext-workflow/src/index.ts"])).toBe(false);
	});
	test("command constant pins the gated files (no DEPLOY matrix)", () => {
		expect(DEPLOY_E2E_COMMAND).toBe(
			"PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts",
		);
		expect(DEPLOY_E2E_COMMAND).not.toContain("PI_AGENT_E2E_DEPLOY");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/ci-deploy-gate.test.ts )`
Expected: FAIL — module `../src/ci-deploy-gate.js` does not exist.

- [ ] **Step 3: Write the module**

```ts
/**
 * ci-deploy-gate — the pure decision behind local_ci's change-triggered
 * deploy-e2e gate.
 *
 * WHY THIS GATE EXISTS: the workflow-derived gate suite already boots all
 * deploy modes on every run (check-deploy-artifacts.sh / check-deploy-sh-e2e.sh
 * via `regression-gates`), but the PI_AGENT_E2E-gated bundle-mode assertions —
 * e2e-patches (every PATCH_TABLE entry reports applied in the built bundle)
 * and e2e-extensions' SOURCE blocks (doctor --smoke, >4 KB module load, lazy
 * `-e` splice) — never ran under local_ci. Those are the tiers that catch the
 * #1305 class (harness literal drift that only fails at the gated tiers), so
 * they run ONLY when the change set touches the deploy-sensitive paths below.
 * One `bun test` process covers both files → the harness's existing
 * per-process ensureBundle() cache means a single bundle build (~15s).
 */
import type { SpawnFn } from "./spawn.js";

/**
 * Repo-relative path fragments that make a change deploy-sensitive. A diff
 * line triggers if it CONTAINS any fragment. Deliberately narrow: touching
 * all of bun-apps/pi-agent/src/** would fire on every pi-agent PR, when the
 * gated assertions only exercise the loader/patch/entry chain listed here.
 */
export const DEPLOY_SENSITIVE_PATTERNS: readonly string[] = [
	"bun-apps/pi-agent-ext-devops/scripts/",
	"bun-apps/pi-agent/run.sh",
	"pi-agent.sh", // repo-root symlink to bun-apps/pi-agent/run.sh
	"bun-apps/pi-agent/package.json", // deploy:* scripts live here
	"bun-apps/pi-agent/src/cli.ts", // the bundled entry
	"bun-apps/pi-agent/src/patches/",
	"bun-apps/pi-agent/src/static-extensions.ts",
	"bun-apps/pi-agent/run-dir/manifest.json",
	"bun-apps/pi-agent/scripts/",
];

/** What the gate runs, from bun-apps/pi-agent. PI_AGENT_E2E only — the
 *  4-cwd DEPLOY matrix needs PI_AGENT_E2E_DEPLOY and stays a manual tier. */
export const DEPLOY_E2E_COMMAND =
	"PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts";

/** The gate's display name in the CiOutcome.gates list (consumed by ci-recipe). */
export const DEPLOY_E2E_GATE_NAME =
	"Deploy e2e — PI_AGENT_E2E bundle assertions (change-triggered)";

/** True when any changed file is deploy-sensitive. */
export function shouldRunDeployE2e(changedFiles: string[]): boolean {
	return changedFiles.some((f) => DEPLOY_SENSITIVE_PATTERNS.some((p) => f.includes(p)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/ci-deploy-gate.test.ts )`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/ci-deploy-gate.ts bun-apps/pi-agent-ext-devops/tests/ci-deploy-gate.test.ts
git commit -m "feat(devops): pure decision module for change-triggered deploy-e2e gate"
```

---

### Task 2: Wire the gate into `runLocalCi` (TDD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/src/ci-recipe.ts` (gates section, after the oneshot-smoke block at ci-recipe.ts:561-585, before the schema-cost block at :587)
- Test: `bun-apps/pi-agent-ext-devops/tests/ci-recipe.test.ts` (new describe block; possibly adjust existing spawn-sequence assertions — see Step 4)

**Interfaces:**
- Consumes: Task 1's `shouldRunDeployE2e`, `DEPLOY_E2E_COMMAND`, `DEPLOY_E2E_GATE_NAME`.
- Produces: a `CiGateResult` named `"Deploy e2e — PI_AGENT_E2E bundle assertions (change-triggered)"` present in `CiOutcome.gates` iff the diff hits a sensitive pattern. Its non-zero exit fails `overall` (existing gate aggregation, ci-recipe.ts:607).

- [ ] **Step 1: Write the failing tests**

Append to `tests/ci-recipe.test.ts` (reuse the file's existing `mkSpawn` / `mkReadPkg` / `mkDetect` / `fakeGates` / `verifyOk` helpers):

```ts
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

	test("sensitive file changed → gate runs with PI_AGENT_E2E command in pi-agent cwd", async () => {
		const { fn, calls } = mkSpawn([
			verifyOk(),
			diffFiles(["bun-apps/pi-agent/src/patches/index.ts"]),
		]);
		const out = await runLocalCi({ ...baseOpts, spawn: fn });
		const gate = out.gates.find((g) => g.name.includes("change-triggered"));
		expect(gate).toBeDefined();
		expect(gate!.exitCode).toBe(0);
		const run = calls.find(
			(c) => c.cmd === "bash" && c.args[1]?.includes("PI_AGENT_E2E=1 bun test"),
		);
		expect(run).toBeDefined();
		expect(run!.cwd).toBe(`${REPO}/bun-apps/pi-agent`);
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
			diffFiles(["pi-agent.sh"]),
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-devops && bun test tests/ci-recipe.test.ts )`
Expected: FAIL — first test: gate undefined (recipe never spawns `git diff --name-only` for this purpose).

- [ ] **Step 3: Implement in ci-recipe.ts**

(a) Add import near the other src imports (after the oneshot-smoke import, ci-recipe.ts:37):

```ts
import {
	DEPLOY_E2E_COMMAND,
	DEPLOY_E2E_GATE_NAME,
	shouldRunDeployE2e,
} from "./ci-deploy-gate.js";
```

(b) Inside the `if (includeGates && !opts.signal?.aborted)` block, AFTER the oneshot-smoke `if (!opts.signal?.aborted) { … }` block (ends ci-recipe.ts:585) and BEFORE the schema-cost block (starts :587), insert:

```ts
			// Change-triggered deploy e2e — the PI_AGENT_E2E bundle-mode
			// assertions (e2e-patches + e2e-extensions SOURCE layers). The
			// workflow-derived gates above already boot every deploy mode, but
			// these assertions only exist behind PI_AGENT_E2E and were
			// manual-tier-only before this gate (#1305 class drift). Runs ONLY
			// when the diff touches a deploy-sensitive path; one bun-test
			// process → ensureBundle()'s per-process cache builds once. A
			// failed `git diff` skips the gate (fail-open): the unconditional
			// deploy-artifact gates above already ran, and a base-ref that
			// cannot diff was already rejected at step 1.
			if (!opts.signal?.aborted) {
				const diff = await spawn("git", ["diff", "--name-only", baseRef, headRef], {
					cwd: opts.repoRoot,
				});
				if (diff.exitCode === 0) {
					const files = diff.stdout
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);
					if (shouldRunDeployE2e(files)) {
						const t0g = now();
						const r = await spawn("bash", ["-c", DEPLOY_E2E_COMMAND], {
							cwd: `${opts.repoRoot}/bun-apps/pi-agent`,
							// Bundle build + suite ≈ 20-40s; 240s only kills a HANG.
							timeoutMs: 240_000,
						});
						gates.push({
							name: DEPLOY_E2E_GATE_NAME,
							exitCode: r.exitCode,
							durationMs: now() - t0g,
							...detailOf(r),
						});
					}
				}
			}
```

NOTE: `CiGateResult` has no `durationMs` field (unlike package results) — if
tsc rejects `durationMs` on the gate literal, DROP the `durationMs` lines
(`t0g` + the property); the gate list carries exit codes only. Check the
interface at ci-recipe.ts:67-75 first.

(c) Extend the recipe's header doc comment (after the paragraph ending
"cannot disagree about what a package's command is.", ci-recipe.ts:26) with:

```ts
 * One gate is hand-added beside the workflow-derived set beyond
 * oneshot-smoke: the change-triggered deploy-e2e gate (src/ci-deploy-gate.ts)
 * — PI_AGENT_E2E bundle-mode assertions, only when the diff is
 * deploy-sensitive (see ci-deploy-gate.ts for the rationale).
```

- [ ] **Step 4: Run the FULL devops suite and fix any sequence-assertion fallout**

Run: `( cd bun-apps/pi-agent-ext-devops && bun run test )`

Known expected fallout: existing tests that assert the exact recorded spawn
sequence will now see an extra `git diff --name-only <base> <head>` call in
gates-enabled runs (default fake response: exit 0 + empty stdout → gate
skipped, `overall` unchanged). Where a test asserts call lists/counts, add the
diff call to the expected sequence — do NOT loosen assertions to "contains".

Expected after adaptation: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/src/ci-recipe.ts bun-apps/pi-agent-ext-devops/tests/ci-recipe.test.ts
git commit -m "feat(devops): local_ci runs PI_AGENT_E2E bundle assertions on deploy-sensitive diffs

Closes the #1305-class blind spot: e2e-patches + e2e-extensions SOURCE
layers now gate merges whose diff touches the deploy/loader/patch chain.
One bun-test process; ensureBundle()'s existing cache builds once."
```

---

### Task 3: Spec ground-truth amendment

**Files:**
- Modify: `.planning/pi-agent-optimization/spec.md` (Phase B section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Append to the Phase B section of the spec** (after its Testing line):

```markdown
### Amendment (2026-08-20, ground truth from a live local_ci run)

The premise "local_ci runs ZERO deploy e2e" was overstated: the
workflow-derived gate suite already runs `Deploy-artifact guard` and
`Deploy-sh L1 e2e` on every run. The actual gap — now closed — was the
`PI_AGENT_E2E`-gated bundle-mode assertions (e2e-patches, e2e-extensions
SOURCE layers), which were manual-tier-only. Item "shared bundle build:
ensureBundle() per-process cache" was moot (cache already existed,
e2e-harness.ts:54-62). Scope otherwise unchanged: change-triggered, ≤ +60s,
glob→trigger decision unit-tested.
```

- [ ] **Step 2: Commit**

```bash
git add .planning/pi-agent-optimization/spec.md
git commit -m "docs(planning): pi-agent-optimization Phase B premise corrected from ground truth"
```

---

### Task 4: Full gate + live verification + PR via devops chain

**Files:** none (verification + PR).

- [ ] **Step 1: Full devops gate**

Run: `( cd bun-apps/pi-agent-ext-devops && bun run test )`
Expected: PASS.

- [ ] **Step 2: LIVE trigger verification** (proves the gate fires end-to-end, not just under fakes)

This branch's own diff touches `bun-apps/pi-agent-ext-devops/src/` — sensitive
only via `bun-apps/pi-agent-ext-devops/scripts/`, which we did NOT touch, so
force the check with an explicit base that makes the diff sensitive: verify by
running local_ci scoped normally and checking the gate is ABSENT (correct
non-trigger), then verify trigger behavior with the unit tests from Task 2
(they are the contract). If you want one live firing: temporarily `git diff`
against a base where run.sh changed is NOT needed — instead run:

```bash
( cd bun-apps/pi-agent && PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts )
```

Expected: PASS, and record the wall-clock (budget evidence; should be ≈ 20-40s
— assert < 90s).

- [ ] **Step 3: Branch prep + local_ci + PR via devops chain**

```bash
bun bun-apps/pi-agent-ext-devops/src/prepare-cli.ts --rebase
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts   # expect overall: pass
# create PR, then:
bun bun-apps/pi-agent-ext-devops/src/pr-finish-cli.ts <pr-number> \
  --expected-scope bun-apps/pi-agent-ext-devops/ --expected-scope .planning/pi-agent-optimization/
bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr-number>
bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts
```

PR title: `feat(devops): Phase B — change-triggered local_ci deploy-e2e gate (PI_AGENT_E2E bundle assertions)`

PR body: the blind-spot story (#1305 class), the ground-truth correction,
decision-module + wiring, budget evidence from Step 2, test summary.
