# Deploy Phase 1a — Retire the Legacy Deploy Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `scripts/deploy.ts`'s four deploy modes and everything whose only job is to build, test, or gate them, after first moving the two things worth keeping (the `extractBareSpecifiers` scanner and the read-only/zero-writes contract) onto the sh pipeline.

**Architecture:** Strictly preserve-then-delete. Tasks 1–3 move surviving value onto the sh pipeline and leave the legacy code untouched and still green. Tasks 4–10 delete, innermost consumer first, so the tree compiles and `local_ci` is green after every commit. No runtime behaviour changes for source mode or for the sh deploy.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, bash. Design spec: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`.

**Branch:** `deploy-arch-simplification` (already created off `origin/main` @ 782d99b8a).

---

## File Structure

**Modified**
- `bun-apps/pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts` — gains the zero-writes-to-a-frozen-tree assertion (Task 1)
- `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts` — gains `extractBareSpecifiers` + its regex + `isValidModuleSpec` (Task 2)
- `bun-apps/pi-agent-ext-devops/src/deploy-argv.ts` — `DeployMode` removed; `VerifyTier` loses `high`/`readonly` (Task 3)
- `bun-apps/pi-agent-ext-devops/src/deploy-tool.ts` — `runDeploy` calls `runShDeploy` instead of spawning `deploy.ts`; `parseDeployOutput` deleted (Task 3)
- `bun-apps/pi-agent-ext-devops/extensions/devops.ts` — `pi_deploy` parameter schema + result text (Task 3)
- `.github/workflows/ci.yml.disabled` — the `Deploy-artifact guard` step removed (Task 4)
- `bun-apps/pi-agent/src/__tests__/e2e-harness.ts` — bundle helpers removed (Task 5)
- `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts` — bundle-routing cases removed (Task 5)
- `bun-apps/pi-agent-ext-devops/scripts/run-test.sh` — `high` / `readonly` tiers removed (Task 6)
- `bun-apps/pi-agent-ext-devops/package.json` — `devops-verify-deploy` bin removed (Task 7)
- `bun-apps/pi-agent/package.json` — `deploy*`, `dist`, `exe` scripts removed (Task 9)
- `bun-apps/pi-agent/update-pi.sh` — `do_rebuild` repointed at the sh deploy (Task 9)

**Created**
- `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.test.ts` — the moved `extractBareSpecifiers` unit tests (Task 2)

**Deleted**
- `bun-apps/pi-agent-ext-devops/scripts/deploy.ts`
- `bun-apps/pi-agent-ext-devops/scripts/lib/build-extensions.ts` + `.test.ts`
- `bun-apps/pi-agent-ext-devops/scripts/lib/ext-hash.ts` + `.test.ts`
- `bun-apps/pi-agent-ext-devops/scripts/lib/deploy-target-guard.test.ts`
- `bun-apps/pi-agent-ext-devops/src/verify-deploy-cli.ts`
- `bun-apps/pi-agent-ext-devops/tests/deploy-tool.test.ts`, `tests/deploy-e2e.test.ts`, `tests/deploy-argv.test.ts` (rewritten, see tasks)
- `scripts/check-deploy-artifacts.sh`
- `bun-apps/pi-agent/src/__tests__/e2e-extensions.test.ts`, `e2e-readonly.test.ts`, `e2e-patches.test.ts`
- `dist/pi-agent/`

---

## Task 1: Move the read-only contract onto the sh e2e suite

`e2e-readonly.test.ts` is the only place asserting that a frozen deploy runs without writing a byte into its own tree. It is deleted in Task 5, so the assertion moves first. `deploy-sh-probe-e2e.test.ts` already deploys with `freeze: true` (from `deploy-config.yaml`) and already boots from a foreign cwd — it is missing only the write-snapshot comparison.

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the existing `describeE2E("pi-agent-sh L1 — the deployed binary really runs its extensions", …)` block, immediately before the final `test("the core still boots after ext/ is removed entirely", …)`:

```typescript
	// Ported from the deleted src/__tests__/e2e-readonly.test.ts, which asserted
	// this for the bundle and snapshot modes. The contract is not mode-specific:
	// a deploy is an IMMUTABLE artifact and every per-user write belongs under
	// PI_CODING_AGENT_DIR. What would break it — a patch that caches into the
	// deploy dir, run.sh losing its JITI_FS_CACHE=0 export, an extension
	// resolving a writable path relative to its own dir — is exactly what the
	// sh pipeline's ext-local resolution makes newly possible, so the assertion
	// belongs here now rather than nowhere.
	test("the frozen tree takes zero writes while the binary runs", async () => {
		const filesIn = (dir: string): string[] => {
			const r = Bun.spawnSync(["find", dir, "-type", "f"]);
			return r.stdout.toString().trim().split("\n").filter(Boolean).sort();
		};

		const before = filesIn(target);
		expect(before.length).toBeGreaterThan(0);

		// doctor --smoke is the heaviest read-only path the deploy has: it boots
		// pi, loads every deployed extension, and counts registered tools.
		const r = await run(["doctor", "--json", "--smoke"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toMatch(/EACCES|EPERM/);

		const after = filesIn(target);
		expect(after).toEqual(before);
	}, 120_000);
```

- [ ] **Step 2: Run it and confirm it passes against today's tree**

This is a characterisation test, not a red-green cycle: the contract already holds and we are moving its only witness. It must pass on the first run — if it fails, the sh deploy is violating the read-only contract *today* and that is a real bug to report, not a test to adjust.

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && PI_AGENT_E2E=1 bun test tests/deploy-sh-probe-e2e.test.ts )
```
Expected: all tests pass, including `the frozen tree takes zero writes while the binary runs`.

- [ ] **Step 3: Prove the test can fail**

Temporarily insert `writeFileSync(join(target, "canary.txt"), "x")` immediately after `const before = filesIn(target);`. Run the same command.

Expected: FAIL — `after` contains `canary.txt`. This proves the `find` snapshot actually compares, rather than comparing two empty lists (the failure mode that made an earlier version of the sh load probe pass while proving nothing).

Then remove the temporary line and re-run to confirm green.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts
git commit -m "test(deploy-sh): port the read-only zero-writes contract onto the L1 e2e

e2e-readonly.test.ts is the only assertion that a frozen deploy writes
nothing into its own tree, and it is bound to the bundle/snapshot modes
being retired. Move the witness before deleting its home."
```

---

## Task 2: Move `extractBareSpecifiers` into `sh-ext-build.ts`

`sh-ext-build.ts` imports this one function from `build-extensions.ts`; everything else in that file serves the legacy pipeline. Move the function, its regex, and its `isValidModuleSpec` helper, with the unit tests that cover the regex's known traps.

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts`
- Create: `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.test.ts`

- [ ] **Step 1: Add the function to `sh-ext-build.ts`**

Delete this import line near the top of `sh-ext-build.ts`:

```typescript
import { extractBareSpecifiers } from "./build-extensions.ts";
```

and insert the following immediately above the existing `matchesAllowed` export:

```typescript
/**
 * A specifier that could plausibly be a module id. Filters the regex's
 * structural false positives (captured operators, fragments with whitespace or
 * brackets) before a caller ever sees them.
 */
function isValidModuleSpec(s: string): boolean {
	if (s.length < 2) return false;
	if (/[\s(){}=;<>+]/.test(s)) return false;
	return true;
}

// The `from` / `import(` alternation matches ESM import + re-export forms.
// The `(?<![\w$-])` lookbehind on `from` is REQUIRED: without it the regex also
// matches a `from` that is merely the TAIL of a larger token — most painfully
// the string `"sql-delete-from"` (is-unsafe's SQL-injection catalog, a
// transitive dep of fast-xml-parser). There `from` is followed by the string's
// closing `"`, so the regex captured `,description:` as a bogus bare specifier
// and aborted the whole deploy. A real `from` keyword is never preceded by a
// word char or `-` (minified `export{a}from"x"` → preceded by `}`;
// `import a from"x"` → preceded by a space), so the lookbehind rejects only the
// false positives. `import(` needs no anchor (the `(` disambiguates).
const BARE_SPEC_RE =
	/(?:((?<![\w$-])from|import\()\s*)(["'])([^"'#.][^"'']*?)\2/g;

/**
 * Scan bundled code for ESM bare specifiers (`from "x"`, `import("x")`,
 * re-export `}from"x"`). Pure + exported so the notoriously fragile regex is
 * unit-testable. Returns the de-duplicated specifiers in first-seen order;
 * template-concat and obviously invalid specs are filtered here so callers see
 * only plausible specifiers.
 */
export function extractBareSpecifiers(code: string): string[] {
	const bare = new Set<string>();
	for (const m of code.matchAll(BARE_SPEC_RE)) {
		const spec = m[3];
		if (spec.includes("${") || spec.includes(" + ")) continue;
		if (!isValidModuleSpec(spec)) continue;
		bare.add(spec);
	}
	return [...bare];
}
```

- [ ] **Step 2: Create the test file with the moved cases**

Create `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.test.ts`:

```typescript
/**
 * sh-ext-build — unit tests for the pure helpers.
 *
 * extractBareSpecifiers scans minified bundle output for ESM bare specifiers
 * (the things Gate 1 checks against the host whitelist). It MUST NOT match a
 * `from` that is merely a substring of a larger token — e.g. the `from` inside
 * `"sql-delete-from"`, which a naive /from\s*["']/ regex misreads and then
 * fails to resolve, breaking the whole deploy. These cases moved here with the
 * function when the legacy build-extensions.ts was retired.
 */
import { describe, expect, test } from "bun:test";
import { extractBareSpecifiers } from "./sh-ext-build.ts";

describe("extractBareSpecifiers", () => {
	test("extracts real ESM bare specifiers", () => {
		const code = `
			import { XMLParser } from "fast-xml-parser";
			import foo from "typebox";
			const dyn = import("node:fs");
			export { x } from "@earendil-works/pi-ai";
		`;
		const specs = extractBareSpecifiers(code);
		expect(specs).toContain("fast-xml-parser");
		expect(specs).toContain("typebox");
		expect(specs).toContain("@earendil-works/pi-ai");
	});

	test("does NOT match `from` inside a hyphenated string token (is-unsafe SQL catalog)", () => {
		const code = `{id:"sql-delete-from",description:"DELETE FROM — data deletion injection",pattern:/\\bDELETE\\s{1,20}FROM\\b/i}`;
		const specs = extractBareSpecifiers(code);
		expect(specs).not.toContain(",description:");
		expect(specs).toEqual([]);
	});

	test("does NOT match `from` inside other hyphenated/word tokens", () => {
		const code = `const a="delete-from";const b="transform-data";const c={fromProperty:"x"}`;
		const specs = extractBareSpecifiers(code);
		expect(specs).not.toContain("x");
		expect(specs).toEqual([]);
	});

	test("still resolves minified re-export with no space: }from\"spec\"", () => {
		const code = `export{a}from"real-pkg";import{b}from"other-pkg"`;
		const specs = extractBareSpecifiers(code);
		expect(specs).toContain("real-pkg");
		expect(specs).toContain("other-pkg");
	});
});
```

- [ ] **Step 3: Run the new tests**

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && bun test scripts/lib/sh-ext-build.test.ts )
```
Expected: 4 pass.

- [ ] **Step 4: Prove the sh deploy still builds with the moved function**

Run:
```bash
bun run --cwd bun-apps/pi-agent deploy:sh --out /tmp/deploy-t2 --no-current --force
```
Expected: exit 0, JSON on stdout listing every configured extension. (Gate 1 is the consumer of `extractBareSpecifiers`; a broken move fails here loudly.)

Then clean up: `chmod -R u+w /tmp/deploy-t2 && rm -rf /tmp/deploy-t2`

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.test.ts
git commit -m "refactor(deploy-sh): move extractBareSpecifiers into sh-ext-build

Its only remaining consumer is Gate 1. Moving it (with the regex trap
cases that justify the lookbehind) unblocks deleting build-extensions.ts."
```

---

## Task 3: Repoint `pi_deploy` at the sh deploy

`pi_deploy` spawns `scripts/deploy.ts` and scrapes its human output with regexes. The sh pipeline returns a typed object, so the tool gets simpler: `parseDeployOutput` is deleted outright, not ported.

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/src/deploy-argv.ts`
- Modify: `bun-apps/pi-agent-ext-devops/src/deploy-tool.ts`
- Modify: `bun-apps/pi-agent-ext-devops/extensions/devops.ts:705-757`
- Rewrite: `bun-apps/pi-agent-ext-devops/tests/deploy-tool.test.ts`
- Modify: `bun-apps/pi-agent-ext-devops/tests/deploy-argv.test.ts`
- Delete: `bun-apps/pi-agent-ext-devops/tests/deploy-e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `bun-apps/pi-agent-ext-devops/tests/deploy-tool.test.ts` with:

```typescript
/**
 * pi_deploy now delegates to runShDeploy (a typed call), so there is no human
 * output left to scrape — the old parseDeployOutput regex suite is gone with
 * the pipeline it parsed. What remains worth testing is the params→options
 * mapping and the failure shaping.
 */
import { describe, expect, test } from "bun:test";
import { runDeploy } from "../src/deploy-tool.ts";

describe("runDeploy", () => {
	test("maps params onto DeployShOptions", async () => {
		let seen: unknown = null;
		const r = await runDeploy(
			{ ext: ["power-tool"], force: true, noFreeze: true },
			{
				deploy: async (opts) => {
					seen = opts;
					return {
						version: "0.1.0+gabc1234",
						target: "/tmp/x/0.1.0+gabc1234",
						extensions: [{ name: "power-tool", bytes: 1000 }],
						coreBytes: 70_000_000,
						currentUpdated: false,
						mode: "ext-only" as const,
					};
				},
			},
		);
		expect(seen).toMatchObject({ onlyExt: ["power-tool"], force: true, freeze: false });
		expect(r.ok).toBe(true);
		expect(r.version).toBe("0.1.0+gabc1234");
		expect(r.extensions).toEqual([{ name: "power-tool", bytes: 1000 }]);
	});

	test("a throwing deploy becomes { ok:false } with the message, not an exception", async () => {
		const r = await runDeploy(
			{},
			{
				deploy: async () => {
					throw new Error("bundle references specifier(s) the host does not provide: foo");
				},
			},
		);
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("host does not provide");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && bun test tests/deploy-tool.test.ts )
```
Expected: FAIL — `runDeploy` does not accept a `deploy` dep and has no `version` / `extensions` fields.

- [ ] **Step 3: Rewrite `deploy-tool.ts`**

Replace the entire contents of `bun-apps/pi-agent-ext-devops/src/deploy-tool.ts` with:

```typescript
/**
 * deploy-tool.ts — pi_deploy: run the versioned sh deploy and shape its result
 * for the tool surface.
 *
 * The deploy itself is scripts/deploy-sh.ts (single source of truth). This file
 * only maps params and shapes failures. It used to spawn scripts/deploy.ts and
 * scrape its human output with regexes; runShDeploy returns a typed object, so
 * that parser is gone rather than ported.
 */
import { runShDeploy, type DeployShOptions, type DeployShResult } from "../scripts/deploy-sh.ts";

export interface DeployParams {
	/** Rebuild only these extensions into the existing version dir. */
	ext?: string[];
	/** Replace an existing version dir. */
	force?: boolean;
	/** Skip chmod a-w on the deployed tree. */
	noFreeze?: boolean;
	/** Do not repoint <outRoot>/current. */
	noCurrent?: boolean;
}

export interface DeployResult {
	ok: boolean;
	version?: string;
	target?: string;
	mode?: DeployShResult["mode"];
	extensions?: Array<{ name: string; bytes: number }>;
	coreBytes?: number;
	currentUpdated?: boolean;
	errorTail?: string;
}

export interface DeployRunDeps {
	deploy?: (opts: DeployShOptions) => Promise<DeployShResult>;
}

/** Run the sh deploy for the given params. Failures are { ok:false } — never a throw. */
export async function runDeploy(
	params: DeployParams,
	deps: DeployRunDeps = {},
): Promise<DeployResult> {
	const deploy = deps.deploy ?? runShDeploy;
	const options: DeployShOptions = {};
	if (params.ext && params.ext.length > 0) options.onlyExt = params.ext;
	if (params.force) options.force = true;
	if (params.noFreeze) options.freeze = false;
	if (params.noCurrent) options.current = false;

	try {
		const r = await deploy(options);
		return {
			ok: true,
			version: r.version,
			target: r.target,
			mode: r.mode,
			extensions: r.extensions,
			coreBytes: r.coreBytes,
			currentUpdated: r.currentUpdated,
		};
	} catch (e) {
		return { ok: false, errorTail: e instanceof Error ? e.message : String(e) };
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && bun test tests/deploy-tool.test.ts )
```
Expected: 2 pass.

- [ ] **Step 5: Update `deploy-argv.ts`**

Delete the `DeployMode`, `DeployParams`, `DEPLOY_MODE_FLAG`, and `buildDeployArgv` declarations (the whole first half of the file, through the closing brace of `buildDeployArgv`). `DeployParams` now lives in `deploy-tool.ts`; nothing builds legacy argv any more.

In the surviving half, narrow the tier union — `high` and `readonly` are the two `run-test.sh` tiers being deleted in Task 6:

```typescript
export type VerifyTier = "quick" | "medium" | "full";
```

Update the file's header comment to drop the `deploy.ts parses argv as…` sentence, leaving only the `run-test.sh` description.

- [ ] **Step 6: Update the dependent files**

In `bun-apps/pi-agent-ext-devops/src/verify-tool.ts`, delete the `high` and `readonly` entries from `TIER_TIMEOUT_MS`:

```typescript
const TIER_TIMEOUT_MS: Record<VerifyTier, number> = {
	quick: 60_000,
	medium: 5 * 60_000,
	full: 15 * 60_000,
};
```

In `bun-apps/pi-agent-ext-devops/tests/deploy-argv.test.ts`, delete every `buildDeployArgv` describe block and any `high`/`readonly` tier case; keep the `buildVerifyArgv` cases for `quick` / `medium` / `full` and `--bail`.

Delete `bun-apps/pi-agent-ext-devops/tests/deploy-e2e.test.ts` (it runs `runDeploy` against the legacy pipeline end to end; the sh pipeline's own e2e is `deploy-sh-probe-e2e.test.ts`):

```bash
git rm bun-apps/pi-agent-ext-devops/tests/deploy-e2e.test.ts
```

In `bun-apps/pi-agent-ext-devops/src/deploy-run.ts`, delete `assertSafeOutDir` (line ~69). It existed because the legacy deploy took an arbitrary out-dir positional; the sh deploy derives every path from `outRoot` in the config, so nothing calls it after this task. Keep `resolvePiAgentDir`, `runScript`, `tailOutput`, and their types — `verify-tool.ts` still uses all three.

In `bun-apps/pi-agent-ext-devops/tests/deploy-run.test.ts`, delete the `assertSafeOutDir` describe block; keep the `resolvePiAgentDir` cases.

- [ ] **Step 7: Update the `pi_deploy` tool registration**

In `bun-apps/pi-agent-ext-devops/extensions/devops.ts`, replace the `pi.registerTool({ name: "pi_deploy", … })` block (starting at the `label:` line, through its closing `});`) with:

```typescript
		label: "Deploy pi-agent",
		description:
			"Build a versioned pi-agent deploy: a minimal core plus independently built extension " +
			"packages under ext/, at <outRoot>/<version>/ (see bun-apps/pi-agent/deploy-config.yaml). " +
			"Returns the version, target dir, per-extension sizes, and whether `current` was repointed.",
		parameters: Type.Object({
			ext: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Rebuild ONLY these extensions into the existing version dir (skips the core compile). " +
						"Omit for a full deploy.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({ description: "Replace an existing version dir. Default: false.", default: false }),
			),
			noFreeze: Type.Optional(
				Type.Boolean({ description: "Skip chmod a-w (dev). Default: false.", default: false }),
			),
			noCurrent: Type.Optional(
				Type.Boolean({ description: "Do not repoint <outRoot>/current. Default: false.", default: false }),
			),
		}),
		async execute(_id, params) {
			try {
				const r = await runDeploy({
					ext: params.ext,
					force: params.force ?? false,
					noFreeze: params.noFreeze ?? false,
					noCurrent: params.noCurrent ?? false,
				});
				const text = r.ok
					? `✓ deployed ${r.version} → ${r.target}\n` +
						`  mode=${r.mode}, core=${((r.coreBytes ?? 0) / 1e6).toFixed(1)}MB, ` +
						`${r.extensions?.length ?? 0} extension(s)` +
						(r.currentUpdated ? ", current repointed" : "")
					: `✗ deploy failed\n${r.errorTail ?? ""}`;
				return {
					content: [{ type: "text" as const, text }],
					details: r,
					isError: r.ok ? undefined : true,
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});
```

Leave the `name`, `gating`, and the preceding comment block intact, but update the comment's "the tools wrap scripts/deploy.ts + run-test.sh" clause to "the tools wrap scripts/deploy-sh.ts + run-test.sh".

- [ ] **Step 8: Typecheck and test the package**

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && bun run typecheck && bun test )
```
Expected: typecheck clean, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add -u bun-apps/pi-agent-ext-devops
git commit -m "refactor(devops): pi_deploy delegates to the sh deploy

runShDeploy returns a typed object, so the regex scraper over deploy.ts's
human output is deleted rather than ported. pi_verify's tier union drops
high/readonly ahead of those run-test.sh tiers being removed."
```

---

## Task 4: Delete the legacy artifact gate

**Files:**
- Delete: `scripts/check-deploy-artifacts.sh`
- Modify: `.github/workflows/ci.yml.disabled`

- [ ] **Step 1: Delete the gate script**

```bash
git rm scripts/check-deploy-artifacts.sh
```

- [ ] **Step 2: Remove its step from `regression-gates`**

In `.github/workflows/ci.yml.disabled`, delete the whole comment block and step, from the line `      # Deploy-bundle guard (blocks). \`bun run deploy\` produces the shipped` through the line `        run: bash scripts/check-deploy-artifacts.sh` inclusive, plus the blank line after it.

`local_ci` derives its gate list from this job, so removing the step is what removes the gate. The remaining steps must stay `if:`-free — `parseCiGates` refuses the whole list rather than guess at conditionals.

- [ ] **Step 3: Verify the workflow-reference guard still passes**

Run:
```bash
( cd bun-apps && bun test tests/ci-workflow-references.test.ts )
```
Expected: PASS. This test scans the workflow for references to files that do not exist; a leftover reference to the deleted script fails it.

- [ ] **Step 4: Verify `local_ci` parses the shortened gate list**

Run:
```bash
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts --list
```
Expected: JSON listing the gates, with no `check-deploy-artifacts.sh` entry and no parse error.

- [ ] **Step 5: Commit**

```bash
git add -u scripts .github
git commit -m "ci: drop the deploy-artifact gate with the modes it gated

It built and booted bundle/exe/snapshot. All three are being retired; the
sh deploy's four build gates plus check-deploy-sh-e2e.sh are what remain."
```

---

## Task 5: Delete the bundle-bound e2e suites

**Files:**
- Delete: `bun-apps/pi-agent/src/__tests__/e2e-extensions.test.ts`, `e2e-readonly.test.ts`, `e2e-patches.test.ts`
- Modify: `bun-apps/pi-agent/src/__tests__/e2e-harness.ts`
- Modify: `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts`

- [ ] **Step 1: Delete the three suites**

```bash
git rm bun-apps/pi-agent/src/__tests__/e2e-extensions.test.ts \
       bun-apps/pi-agent/src/__tests__/e2e-readonly.test.ts \
       bun-apps/pi-agent/src/__tests__/e2e-patches.test.ts
```

All three call `ensureBundle()` and assert against a `--bundle` / `--snapshot` deploy. The read-only contract they carried moved to `deploy-sh-probe-e2e.test.ts` in Task 1.

- [ ] **Step 2: Trim `e2e-harness.ts`**

Delete these exports and everything only they use: `DIST_BUNDLE`, `DEPLOY_SCRIPT`, `DEPLOY_ENABLED`, `ensureBundle`, `runBundle`, `SpawnResult`, the module-level `bundlePromise`, and the `truthy` call for `PI_AGENT_E2E_DEPLOY`.

Keep: `PI_AGENT_DIR`, `REPO_ROOT`, `SRC_CLI`, `E2E_ENABLED`, and the `truthy` helper.

Replace the file's header comment with:

```typescript
/**
 * e2e-harness — shared path constants and the E2E opt-in gate for pi-agent's
 * remaining end-to-end tests.
 *
 * It used to build a bundle deploy and spawn it (ensureBundle/runBundle). That
 * machinery went with the four legacy deploy modes: the deployed artifact is
 * now the versioned sh tree, and its e2e lives in
 * pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts, which deploys through
 * runShDeploy directly rather than through a shared build cache.
 */
```

- [x] **Step 3: e2e-launcher.test.ts — DEVIATION: keep the bundle cases, defer to 1b**

The plan called for deleting three tests here (`pi-agent.js alone -> deployed (bundle)`,
and the two `.deploy-readonly` env-export cases). **Not done, deliberately.**

They assert an arm of `pi-agent.sh` that is still LIVE in 1a: the launcher's
`pi-agent.js` entry detection and its `.deploy-readonly` env exports are removed in
Phase 1b, together with `mode.ts`'s `"bundle"` and `resolve.ts`'s `deploy-bundle`
layout. Deleting the tests in 1a would leave live behaviour untested for a whole PR
— the exact gap this file's own header documents.

They go in 1b, with the behaviour. Only the file's header comment is updated here,
because it referenced the three suites deleted in Step 1.

- [ ] **Step 4: Run the surviving e2e suites**

Run:
```bash
( cd bun-apps/pi-agent && PI_AGENT_E2E=1 bun test src/__tests__/ )
```
Expected: PASS, with no `Module not found` and no reference to `ensureBundle`.

- [ ] **Step 5: Run the package's full suite**

Run:
```bash
( cd bun-apps/pi-agent && bun test && bun run typecheck )
```
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -u bun-apps/pi-agent/src/__tests__
git commit -m "test(pi-agent): delete the bundle-mode e2e suites

e2e-extensions / e2e-readonly / e2e-patches each build a --bundle or
--snapshot deploy and assert against it. Both modes are being retired.
The harness keeps only its path constants and the E2E opt-in gate."
```

---

## Task 6: Remove the `high` and `readonly` tiers from `run-test.sh`

**Files:**
- Modify: `bun-apps/pi-agent-ext-devops/scripts/run-test.sh`

- [ ] **Step 1: Delete the tier bodies**

Delete the `run_extensions()` and `run_readonly()` function definitions. Both spawn deploys of the modes being retired, and both call test files deleted in Task 5.

- [ ] **Step 2: Delete the tier dispatch arms**

In the `case "$EFFORT" in` block, delete the `high)` and `readonly)` arms entirely. In the `full)` arm, delete the two `step "…"` lines that call `run_extensions` / `run_readonly` and the two `echo` banners above them, leaving the smoke step and the sibling-package loop.

Replace the removed `full)` lines with a single medium-tier step so `full` still covers patches:

```bash
		step "unit + patch e2e (medium)" run_patches
```

- [ ] **Step 3: Update the header and `print_list`**

In the header comment block, delete the `high (2)` and `readonly (2.5)` tier rows and the two `./run-test.sh …` usage lines for them. In `print_list()`, delete the corresponding `$(G high)` and `$(G readonly)` lines.

- [ ] **Step 4: Run every surviving tier**

Run:
```bash
bash bun-apps/pi-agent-ext-devops/scripts/run-test.sh quick
bash bun-apps/pi-agent-ext-devops/scripts/run-test.sh medium
bash bun-apps/pi-agent-ext-devops/scripts/run-test.sh --list
```
Expected: `quick` and `medium` exit 0; `--list` prints only `quick`, `medium`, `smoke`, `full`.

- [ ] **Step 5: Confirm no caller still passes a removed tier**

Run:
```bash
grep -rn "run-test.sh \(high\|readonly\)\|tier.*\"high\"\|tier.*\"readonly\"" \
  --include="*.ts" --include="*.sh" --include="*.md" --include="*.yml" --include="*.disabled" \
  bun-apps scripts .github | grep -v node_modules
```
Expected: no output. (Hits inside `.planning/` or `vaults_root/` are historical records and are left alone.)

- [ ] **Step 6: Commit**

```bash
git add -u bun-apps/pi-agent-ext-devops/scripts/run-test.sh
git commit -m "test(devops): drop run-test.sh's high and readonly tiers

Both exist to deploy bundle/snapshot/standalone and run the e2e suites
deleted with them. quick / medium / smoke / full remain."
```

---

## Task 7: Delete `verify-deploy-cli.ts`

**Files:**
- Delete: `bun-apps/pi-agent-ext-devops/src/verify-deploy-cli.ts`
- Modify: `bun-apps/pi-agent-ext-devops/package.json`

- [ ] **Step 1: Confirm nothing invokes it**

Run:
```bash
grep -rn "devops-verify-deploy\|verify-deploy-cli" \
  --include="*.ts" --include="*.sh" --include="*.json" --include="*.yml" --include="*.disabled" \
  bun-apps scripts .github | grep -v node_modules | grep -v "^bun-apps/tests/ci-workflow-references.test.ts"
```
Expected: only the `package.json` bin line and the file itself. The `ci-workflow-references.test.ts` hits are prose in comments, not invocations.

- [ ] **Step 2: Delete the file and its bin entry**

```bash
git rm bun-apps/pi-agent-ext-devops/src/verify-deploy-cli.ts
```

In `bun-apps/pi-agent-ext-devops/package.json`, delete this line from the `bin` object:

```json
    "devops-verify-deploy": "./src/verify-deploy-cli.ts",
```

- [ ] **Step 3: Verify the package still resolves its bins**

Run:
```bash
( cd bun-apps && bun test tests/package-scripts-runnable.test.ts )
( cd bun-apps/pi-agent-ext-devops && bun run typecheck )
```
Expected: PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add -u bun-apps/pi-agent-ext-devops
git commit -m "chore(devops): delete verify-deploy-cli

Steps 3-5 built and booted a --bundle deploy; steps 1-2 (bun install,
quick tests) are local_ci's job. Nothing invoked it."
```

---

## Task 8: Delete the legacy deploy scripts

Everything that imported these is gone as of Task 7, so this is the last consumer-free moment.

**Files:**
- Delete: `bun-apps/pi-agent-ext-devops/scripts/deploy.ts`
- Delete: `bun-apps/pi-agent-ext-devops/scripts/lib/build-extensions.ts` + `build-extensions.test.ts`
- Delete: `bun-apps/pi-agent-ext-devops/scripts/lib/ext-hash.ts` + `ext-hash.test.ts`
- Delete: `bun-apps/pi-agent-ext-devops/scripts/lib/deploy-target-guard.test.ts`

- [ ] **Step 1: Confirm no surviving import**

Run:
```bash
grep -rn "scripts/deploy\.ts\|build-extensions\|ext-hash" \
  --include="*.ts" --include="*.sh" --include="*.json" \
  bun-apps scripts | grep -v node_modules | grep -v "\.planning/"
```
Expected: no output.

- [ ] **Step 2: Delete**

```bash
git rm bun-apps/pi-agent-ext-devops/scripts/deploy.ts \
       bun-apps/pi-agent-ext-devops/scripts/lib/build-extensions.ts \
       bun-apps/pi-agent-ext-devops/scripts/lib/build-extensions.test.ts \
       bun-apps/pi-agent-ext-devops/scripts/lib/ext-hash.ts \
       bun-apps/pi-agent-ext-devops/scripts/lib/ext-hash.test.ts \
       bun-apps/pi-agent-ext-devops/scripts/lib/deploy-target-guard.test.ts
```

`deploy-target-guard.test.ts` guards `deploy.ts`'s "the out-dir is a free positional, so `bun run deploy /opt` deletes `/opt`" hazard. The sh deploy takes `outRoot` from config and derives version dirs from it, so the hazard has no habitat — this is retiring a guard with its bug class, not dropping a check.

- [ ] **Step 3: Typecheck and test the package**

Run:
```bash
( cd bun-apps/pi-agent-ext-devops && bun run typecheck && bun test )
```
Expected: typecheck clean, all tests pass.

- [ ] **Step 4: Prove the sh deploy is unaffected**

Run:
```bash
bun run --cwd bun-apps/pi-agent deploy:sh --out /tmp/deploy-t8 --no-current --force
```
Expected: exit 0, JSON listing every configured extension.

Then: `chmod -R u+w /tmp/deploy-t8 && rm -rf /tmp/deploy-t8`

- [ ] **Step 5: Commit**

```bash
git add -u bun-apps/pi-agent-ext-devops/scripts
git commit -m "feat(deploy): delete the four legacy deploy modes

--bundle / --snapshot / --standalone rely on a node_modules symlink into
the machine-global bun store and cannot leave the build machine; --exe is
dominated by the sh deploy, which produces the same compiled core plus
independently rebuildable extensions under five gates. None had a consumer
outside its own gate.

Takes with it the second extension bundler (whose private BUILTINS list had
already drifted from the core's — missing http2/constants/domain/punycode)
and the warm-build hash cache that only it used."
```

---

## Task 9: Remove the package scripts and repoint `update-pi.sh`

**Files:**
- Modify: `bun-apps/pi-agent/package.json`
- Modify: `bun-apps/pi-agent/update-pi.sh`

- [ ] **Step 1: Delete the dead scripts**

In `bun-apps/pi-agent/package.json`, delete these entries from `scripts`:

```json
    "dist": "bun ../../dist/pi-agent/pi-agent.js",
    "exe": "../../dist/pi-agent/pi-agent",
    "deploy": "bun ../pi-agent-ext-devops/scripts/deploy.ts",
    "deploy:bundle": "bun ../pi-agent-ext-devops/scripts/deploy.ts --bundle",
    "deploy:snapshot": "bun ../pi-agent-ext-devops/scripts/deploy.ts --snapshot",
    "deploy:standalone": "bun ../pi-agent-ext-devops/scripts/deploy.ts --standalone",
    "deploy:exe": "bun ../pi-agent-ext-devops/scripts/deploy.ts --exe",
```

and replace the `"//deploy"` documentation key with:

```json
    "//deploy": "ONE deploy pipeline: `bun run deploy:sh` → ../pi-agent-ext-devops/src/deploy-sh-cli.ts. Builds a versioned tree at ~/proj/dist/pi-agent-sh/<version>/ — a minimal compiled core (src/cli-sh.ts, zero extensions inside) plus extension packages under ext/<name>/ that the core discovers at runtime. Config: deploy-config.yaml. Docs: docs/deploy-sh.md. The four legacy modes (--bundle/--snapshot/--standalone/--exe) were retired in the deploy-architecture consolidation; see .planning/specs/2026-08-20-deploy-architecture-consolidation-design.md.",
```

Keep `deploy:sh` exactly as it is.

- [ ] **Step 2: Repoint `do_rebuild` in `update-pi.sh`**

Replace the `do_rebuild()` function (comment block included) with:

```bash
# Rebuild the pi-agent deploy. Extracted to a function so the early-exit
# "already up to date" path can honor --rebuild too: a prior run may have bumped
# pins + reconciled bun.lock without rebuilding, and --rebuild is an explicit
# request to rebuild regardless of whether versions changed this run.
#
# NOTE: this now produces a NEW VERSIONED DEPLOY at ~/proj/dist/pi-agent-sh/
# and repoints `current` at it — a more consequential action than the old
# dist/pi-agent bundle rebuild it replaces. The four legacy deploy modes were
# retired in the deploy-architecture consolidation; deploy:sh is the only
# pipeline. Pass --no-current through the CLI directly if you want a build
# without moving `current`.
do_rebuild() {
  echo
  echo "$(green '▶') rebuild pi-agent deploy (versioned, repoints current)"
  (cd "$REPO_ROOT/bun-apps/pi-agent" && bun run deploy:sh --force)
}
```

- [ ] **Step 3: Update the `--rebuild` help text**

In the header's `USAGE` block, change:

```
#   ./bun-apps/pi-agent/update-pi.sh --rebuild  # also rebuild pi-agent dist bundle
```

to:

```
#   ./bun-apps/pi-agent/update-pi.sh --rebuild  # also cut a new versioned deploy (moves `current`)
```

and change the final next-steps line from `rebuild the bundle when ready` to `cut a new deploy when ready`.

- [ ] **Step 4: Verify the scripts guard passes**

Run:
```bash
( cd bun-apps && bun test tests/package-scripts-runnable.test.ts )
bash bun-apps/pi-agent/update-pi.sh --lockstep
```
Expected: test PASS; `--lockstep` prints `✓ lockstep OK` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add -u bun-apps/pi-agent/package.json bun-apps/pi-agent/update-pi.sh
git commit -m "chore(pi-agent): drop the legacy deploy scripts; --rebuild cuts an sh deploy

update-pi.sh --rebuild now produces a versioned deploy and repoints
current, which is more consequential than the dist/pi-agent bundle it
replaces — the help text says so."
```

---

## Task 10: Remove `dist/pi-agent` and verify the whole tree

**Files:**
- Delete: `dist/pi-agent/` (gitignored build output — a filesystem delete, not a git one)

- [ ] **Step 1: Remove the stale artifact tree**

```bash
chmod -R u+w dist/pi-agent 2>/dev/null || true
rm -rf dist/pi-agent
```

Nothing regenerates it now. It is gitignored (`.gitignore:44`), so there is nothing to commit for this step alone.

- [ ] **Step 2: Confirm no live reference survives**

Run:
```bash
grep -rn "dist/pi-agent" \
  --include="*.ts" --include="*.sh" --include="*.json" --include="*.yml" --include="*.disabled" \
  bun-apps scripts .github | grep -v node_modules
```
Expected: no output. Hits in `*.md`, `.planning/`, or `vaults_root/` are documentation and history — Task 1b of the spec folds the docs; leave them for that PR.

- [ ] **Step 3: Run the full local CI**

Run:
```bash
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts
```
Expected: every gate green. This is the gate that decides the PR.

- [ ] **Step 4: Confirm the deployed artifact still works end to end**

Run:
```bash
bun run --cwd bun-apps/pi-agent deploy:sh --out /tmp/deploy-final --no-current --force
/tmp/deploy-final/*/pi-agent --ext-list
```
Expected: the deploy exits 0, and `--ext-list` reports every extension in `deploy-config.yaml` as loaded with an empty `skipped` array.

Then: `chmod -R u+w /tmp/deploy-final && rm -rf /tmp/deploy-final`

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin deploy-arch-simplification
```

Then open the PR with `gh pr create`, titling it
`feat(deploy): Phase 1a — retire the four legacy deploy modes` and linking the design spec in the body.

---

## Verification summary

| what | command | expected |
|---|---|---|
| sh deploy builds | `bun run --cwd bun-apps/pi-agent deploy:sh --out /tmp/x --no-current --force` | exit 0, JSON |
| deployed binary loads its extensions | `/tmp/x/*/pi-agent --ext-list` | every configured name in `loaded`, `skipped` empty |
| sh L1 e2e (incl. the ported zero-writes contract) | `( cd bun-apps/pi-agent-ext-devops && PI_AGENT_E2E=1 bun test tests/deploy-sh-probe-e2e.test.ts )` | all pass |
| devops package | `( cd bun-apps/pi-agent-ext-devops && bun run typecheck && bun test )` | clean |
| pi-agent package | `( cd bun-apps/pi-agent && bun run typecheck && bun test )` | clean |
| everything | `bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts` | all gates green |

## Out of scope for this plan

- Collapsing `"bundle"` out of `mode.ts` / `resolve.ts` / `run-context.ts` / `set-package-dir.ts`, the `pi-agent.sh` launcher arm, the file renames, and the docs fold — that is Phase 1b.
- Anything touching `deploy-config.yaml`, `manifest.json`, or `static-extensions.ts` — that is Phase 2, and it must not start while a sibling worktree has registry changes in flight.
