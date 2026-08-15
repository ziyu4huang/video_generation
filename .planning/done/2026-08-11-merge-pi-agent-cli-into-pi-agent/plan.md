# Merge `pi-agent-cli` into `pi-agent` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `@repo/pi-agent-cli` workspace package and re-expose its entire
command surface as `pi-agent cli <command>`, without changing any existing
`pi-agent` / `./pi-agent.sh` behavior.

**Architecture:** `pi-agent/src/cli.ts` gains a third argv intercept
(`argv[0] === "cli"`) beside the existing `doctor` / `ext doctor` ones, placed
**before `applyPatches()`**. It lazily `await import("./cli/dispatch.ts")` — so the
TUI path never evaluates the CLI subtree, and the CLI path never inherits the TUI's
run-dir manifest, provider patch, or 13 static extension factories. The CLI's
per-command tool curation (ADR 0001) therefore survives untouched.

**Tech Stack:** Bun (workspace at `bun-apps/`, isolated linker), TypeScript,
`bun:test`, `@earendil-works/pi-coding-agent` SDK.

**Spec:** `.planning/2026-08-11-merge-pi-agent-cli-into-pi-agent/spec.md`

---

## Ground rules for every task

- Run all `bun` commands from the repo root using `--cwd` or a subshell.
  **Never** top-level `cd` — `.claude/hooks/no-cd-drift.sh` blocks it.
  - `bun run --cwd bun-apps/pi-agent <script>` (note: `--cwd` goes *after* `run`)
  - `( cd bun-apps/pi-agent && bun test )` for `bun test` (it has no `--cwd`)
- `bun install` is run from `bun-apps/`, never the repo root.
- Commit after every task. Never commit `package-lock.json`.
- The branch is already `movie-director-gating-hygiene`; if `git status` shows you
  are on `main`, create a branch first.

## File structure

| Path | Responsibility | Status |
|---|---|---|
| `bun-apps/pi-agent/src/cli-argv.ts` | pure argv classification for the pre-patch intercepts | modify (+`isCliCommand`) |
| `bun-apps/pi-agent/src/cli-argv.test.ts` | unit tests for the above | modify |
| `bun-apps/pi-agent/src/cli.ts` | TUI entry; three intercepts then `applyPatches()` + `main()` | modify (+1 branch) |
| `bun-apps/pi-agent/src/cli/dispatch.ts` | CLI root dispatch; exports `runCli(argv): Promise<number>` | create (moved from `pi-agent-cli/src/cli.ts`) |
| `bun-apps/pi-agent/src/cli/**` | args, flag-spec, 23 commands, 4 sessions, 3 extensions | moved verbatim |
| `bun-apps/pi-agent/src/cli/__tests__/**` | 29 test files | moved |
| `bun-apps/pi-agent/workflows/` | example workflow packs + self-improve scripts | moved |
| `bun-apps/pi-agent/baselines/` | schema-cost baseline + error-rate notes | moved |
| `bun-apps/pi-agent/docs/adr/0001…0008` | the CLI's ADRs | moved |
| `bun-apps/pi-agent/scripts/deploy.ts` | 4 deploy modes + new `--obfuscate` | modify |
| `bun-apps/pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts` | child-process subagent argv | modify (entry prefix) |
| `bun-apps/pi-agent-cli/` | — | **deleted** |

---

## Task 1: Add `isCliCommand` to the argv classifier

This is pure, side-effect-free, and testable before anything moves. Do it first so
the intercept has a tested predicate to call.

**Files:**
- Modify: `bun-apps/pi-agent/src/cli-argv.ts`
- Test: `bun-apps/pi-agent/src/cli-argv.test.ts`

- [ ] **Step 1: Write the failing test**

Add this block to `bun-apps/pi-agent/src/cli-argv.test.ts`, immediately after the
existing `describe("isExtDoctorCommand", …)` block:

```ts
describe("isCliCommand", () => {
	test("true for the `cli` namespace token", () => {
		expect(isCliCommand(["cli"])).toBe(true);
		expect(isCliCommand(["cli", "zk-ask", "what?"])).toBe(true);
	});

	test("false when argv[0] is not `cli`", () => {
		expect(isCliCommand([])).toBe(false);
		expect(isCliCommand(["doctor"])).toBe(false);
		expect(isCliCommand(["-p", "hello"])).toBe(false);
	});

	// The whole point of matching only argv[0]: a literal "cli" travelling as a
	// PROMPT or a flag VALUE must reach pi untouched, exactly like isDoctorCommand.
	test("a literal 'cli' passed as a prompt or flag value is NOT hijacked", () => {
		expect(isCliCommand(["-p", "cli"])).toBe(false);
		expect(isCliCommand(["--append-system-prompt", "cli"])).toBe(false);
		expect(isCliCommand(["--model", "sonnet", "-p", "cli"])).toBe(false);
	});
});
```

Also add `isCliCommand` to the import list at the top of the file:

```ts
import {
	isDoctorCommand,
	isExtDoctorCommand,
	isCliCommand,
	userSuppressFlags,
	userExtensionPaths,
	overriddenStaticExtensions,
} from "./cli-argv.ts";
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: FAIL — `isCliCommand is not a function` (or a TS/import resolution error).

- [ ] **Step 3: Implement `isCliCommand`**

Add to `bun-apps/pi-agent/src/cli-argv.ts`, directly below `isExtDoctorCommand`:

```ts
/**
 * True iff argv should route into the non-interactive CLI namespace
 * (`pi-agent cli <command> …`). Only `argv[0]` triggers it — same contract as
 * isDoctorCommand: matching a `cli` token ANYWHERE would also match a literal
 * prompt (`-p "cli"`) or a flag value, silently hijacking it.
 */
export function isCliCommand(argv: string[]): boolean {
	return argv[0] === "cli";
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: PASS, all `isCliCommand` cases green, no existing case regressed.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/src/cli-argv.ts bun-apps/pi-agent/src/cli-argv.test.ts
git commit -m "feat(pi-agent): add isCliCommand argv classifier for the cli namespace"
```

---

## Task 2: Move the source tree

A pure file move with import-path rewrites. No behavior change yet — the moved code
is not reachable until Task 4 wires the intercept.

**Files:**
- Move: `bun-apps/pi-agent-cli/src/**` → `bun-apps/pi-agent/src/cli/**`
- Move: `bun-apps/pi-agent-cli/tests/*.test.ts` → `bun-apps/pi-agent/src/cli/__tests__/`
- Move: `bun-apps/pi-agent-cli/workflows/` → `bun-apps/pi-agent/workflows/`
- Move: `bun-apps/pi-agent-cli/baselines/` → `bun-apps/pi-agent/baselines/`
- Move: `bun-apps/pi-agent-cli/docs/adr/` → `bun-apps/pi-agent/docs/adr/`
- Move: `bun-apps/pi-agent-cli/docs/{KNOWLEDGE-LAYER.md,workflow-cli.md}` → `bun-apps/pi-agent/docs/`

- [ ] **Step 1: Move the files with `git mv` (preserves history)**

```bash
mkdir -p bun-apps/pi-agent/src/cli bun-apps/pi-agent/docs/adr
git mv bun-apps/pi-agent-cli/src/args.ts          bun-apps/pi-agent/src/cli/args.ts
git mv bun-apps/pi-agent-cli/src/flag-spec.ts     bun-apps/pi-agent/src/cli/flag-spec.ts
git mv bun-apps/pi-agent-cli/src/cli.ts           bun-apps/pi-agent/src/cli/dispatch.ts
git mv bun-apps/pi-agent-cli/src/commands         bun-apps/pi-agent/src/cli/commands
git mv bun-apps/pi-agent-cli/src/sessions         bun-apps/pi-agent/src/cli/sessions
git mv bun-apps/pi-agent-cli/src/extensions       bun-apps/pi-agent/src/cli/extensions
git mv bun-apps/pi-agent-cli/src/__tests__        bun-apps/pi-agent/src/cli/__tests__
git mv bun-apps/pi-agent-cli/tests/workflow-command.test.ts      bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts
git mv bun-apps/pi-agent-cli/tests/workflow-portable-e2e.test.ts bun-apps/pi-agent/src/cli/__tests__/workflow-portable-e2e.test.ts
git mv bun-apps/pi-agent-cli/workflows            bun-apps/pi-agent/workflows
git mv bun-apps/pi-agent-cli/baselines            bun-apps/pi-agent/baselines
git mv bun-apps/pi-agent-cli/docs/adr/0001-extensions-baked-in-not-manifest.md        bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0002-passthrough-is-self-subagent-target.md     bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0003-distill-llm-only-in-enrich.md              bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0004-two-read-paths-deliberately-different.md   bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0005-provider-catalog-from-pi-agent.md          bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0006-dry-run-excludes-write-tools.md            bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0007-runtime-e-headless-pack-extensions.md      bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/adr/0008-portable-workflow-pack-discovery.md        bun-apps/pi-agent/docs/adr/
git mv bun-apps/pi-agent-cli/docs/KNOWLEDGE-LAYER.md bun-apps/pi-agent/docs/KNOWLEDGE-LAYER.md
git mv bun-apps/pi-agent-cli/docs/workflow-cli.md    bun-apps/pi-agent/docs/workflow-cli.md
# Package docs, staged here so Task 9 can fold them in AFTER the package is
# deleted. `_`-prefixed ones are consumed and removed in Task 9; the other two
# are keepers under their new names.
git mv bun-apps/pi-agent-cli/CONTEXT.md      bun-apps/pi-agent/docs/_cli-CONTEXT.md
git mv bun-apps/pi-agent-cli/README.md       bun-apps/pi-agent/docs/_cli-README.md
git mv bun-apps/pi-agent-cli/PRD.md          bun-apps/pi-agent/docs/cli-PRD.md
git mv bun-apps/pi-agent-cli/VERIFICATION.md bun-apps/pi-agent/docs/cli-VERIFICATION.md
```

`pi-agent/docs/` has no `KNOWLEDGE-LAYER.md` today, so that move needs no rename.

- [ ] **Step 2: Turn `dispatch.ts`'s `main()` into an exported `runCli()`**

Three edits in `bun-apps/pi-agent/src/cli/dispatch.ts`, in order.

**(a)** Rename the entry function and take argv as a parameter. Change
`async function main(): Promise<void> {` to:

```ts
/**
 * The CLI's own dispatch. `argv` is everything AFTER the `cli` namespace token
 * — `pi-agent cli zk-ask "x"` reaches this as ["zk-ask", "x"].
 */
async function dispatch(argv: string[]): Promise<void> {
```

**(b)** Delete the now-shadowing first line of that function body:

```ts
	const argv = process.argv.slice(2);   // ← DELETE; argv is the parameter now
```

**(c)** Replace the file's final `import.meta.main` block:

```ts
if (import.meta.main) {
  try {
    await main();
  } catch (e: any) {
    console.error(`error: ${e?.message ?? String(e)}`);
    process.exit(1);
  }
}
```

with the exported wrapper. It keeps the old block's error contract but returns an
exit code instead of terminating, so `src/cli.ts` owns process termination:

```ts
/**
 * Run the non-interactive CLI and return its exit code.
 *
 * Called only from src/cli.ts's `cli` intercept — this module has no
 * `import.meta.main` entry any more, and must not gain one: it is reached
 * exclusively through pi-agent's single binary.
 */
export async function runCli(argv: string[]): Promise<number> {
	try {
		await dispatch(argv);
		return 0;
	} catch (e: any) {
		// Graceful failure for any thrown command error (bad input, invalid flags,
		// etc.): print a clean one-liner instead of dumping a stack trace.
		console.error(`error: ${e?.message ?? String(e)}`);
		return 1;
	}
}
```

Leave the internal `die()` helper alone — its `process.exit(1)` is an existing,
intentional hard-exit path for usage errors.

- [ ] **Step 3: Rewrite the `@repo/pi-agent` imports to local relative paths**

`bun-apps/pi-agent/src/cli/sessions/shared.ts`:

```ts
// was: import { registerAllProviders } from "@repo/pi-agent";
import { registerAllProviders } from "../../pre-load-providers.ts";
```

`bun-apps/pi-agent/src/cli/commands/doctor.ts`:

```ts
// was: import { isFailing, type CheckStatus, type CheckResult } from "@repo/pi-agent";
import { isFailing, type CheckStatus, type CheckResult } from "../../doctor.ts";
```

Both targets are already verified: `registerAllProviders` is exported at
`src/pre-load-providers.ts:148`, and `CheckStatus` / `CheckResult` / `isFailing` at
`src/doctor.ts:36` / `:38` / `:47`. `@repo/pi-agent` resolved to `src/index.ts`,
which merely re-exports both modules, so these relative imports reach the same
definitions.

`src/cli/commands/doctor.ts` also **re-exports** those three symbols for its own
test file — keep that re-export line exactly as it is; only the import source changes.

- [ ] **Step 4: Fix the e2e helper's spawn target**

`bun-apps/pi-agent/src/cli/__tests__/e2e/_helpers.ts` — the file now lives at
`<pkg>/src/cli/__tests__/e2e/`, four levels below the package root, and must spawn
the merged entry with the `cli` prefix:

```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
// _helpers.ts lives at <pkg>/src/cli/__tests__/e2e/ → up FOUR levels to pkg root.
const pkgDir = join(__dirname, "..", "..", "..", "..");
```

and in `runCli()`:

```ts
	const proc = Bun.spawnSync({
		// The CLI is reached through pi-agent's own entry under the `cli`
		// namespace token — there is no standalone pi-agent-cli binary any more.
		cmd: [process.execPath, "src/cli.ts", "cli", ...args],
		cwd: pkgDir,
```

- [ ] **Step 5: Fix `boot-smoke.test.ts`'s paths and canary argv**

`bun-apps/pi-agent/src/cli/__tests__/boot-smoke.test.ts`:

```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
// test lives at <pkg>/src/cli/__tests__ — up THREE levels to the package root,
// then TWO more (pkg → bun-apps → repo root).
const pkgDir = join(__dirname, "..", "..", "..");   // bun-apps/pi-agent
const repoRoot = join(pkgDir, "..", "..");          // repo root
```

and in `runCanary()`:

```ts
    cmd: [process.execPath, "src/cli.ts", "cli", "tools-metrics", "--schema-cost", "--json"],
```

`__fixtures__/boot-smoke.baseline.json` is **unchanged** — its values
(`toolCountFloor`, `sourceMinimum`, …) come from `discoverExtensionEntries()`, which
reads `bun-apps/pi-agent/run-dir/manifest.json` via a `resolveRepoRoot()` walk-up.
Neither is affected by the move. If this test's tool counts do shift, that is a real
regression, not an expected baseline drift — investigate, do not regenerate.

- [ ] **Step 6: Sweep the remaining moved-file path assumptions**

```bash
grep -rn "\.\./\.\./\.\./" bun-apps/pi-agent/src/cli/__tests__/
grep -rn "pi-agent-cli" bun-apps/pi-agent/src/cli/ bun-apps/pi-agent/workflows/
```

Every hit under `src/cli/` and `workflows/` that names `pi-agent-cli` in a **path**
(as opposed to prose) becomes `pi-agent`, and the invocation strings gain the `cli`
token. The concrete ones:

- `bun-apps/pi-agent/workflows/knowledge-distill.js` lines 159, 190, 229, 255, 256
- `bun-apps/pi-agent/workflows/retrieval-quality-self-improve.js` lines 134, 176, 233, 235
- `bun-apps/pi-agent/workflows/{echo,args-demo,sample}/manifest.json` — the `howToRun` field

Each rewrites from:

```
bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-query …
```

to:

```
bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent' src/cli.ts cli zk-query …
```

except `retrieval-quality-self-improve.js:176`, which points at a helper script
rather than the CLI and only needs the directory renamed:

```
bun '${PROJECT_ROOT}/bun-apps/pi-agent/workflows/lib/lexical-overlap-check.mjs' …
```

- [ ] **Step 7: Commit the move (tests will not pass yet — the intercept is Task 4)**

```bash
git add -A bun-apps/pi-agent bun-apps/pi-agent-cli
git commit -m "refactor(pi-agent): move pi-agent-cli source tree into src/cli/"
```

---

## Task 3: Merge `package.json` and delete the old package

**Files:**
- Modify: `bun-apps/pi-agent/package.json`
- Delete: `bun-apps/pi-agent-cli/` (whatever remains)
- Regenerate: `bun-apps/bun.lock`

- [ ] **Step 1: Add the dependencies**

In `bun-apps/pi-agent/package.json`, extend `dependencies` with the packages that
`src/cli/**` imports. Ten are already imported elsewhere in `pi-agent` via relative
paths (`src/static-extensions.ts`) but were never declared; the CLI imports them as
bare specifiers, so they must now be real deps.

Pin the two `@earendil-works/*` additions to **exactly** `0.84.1` — the same version
as the existing `@earendil-works/pi-coding-agent` entry. These four packages are
published in lockstep and `update-pi.sh` upgrades them together; a range here would
let them drift.

```json
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.84.1",
    "@earendil-works/pi-ai": "0.84.1",
    "@earendil-works/pi-coding-agent": "0.84.1",
    "@repo/pi-agent-ext-core-task": "workspace:*",
    "@repo/pi-agent-ext-file2md": "workspace:*",
    "@repo/pi-agent-ext-flux2": "workspace:*",
    "@repo/pi-agent-ext-hermes-memory": "workspace:*",
    "@repo/pi-agent-ext-knowledge-card": "workspace:*",
    "@repo/pi-agent-ext-krea2": "workspace:*",
    "@repo/pi-agent-ext-ltx": "workspace:*",
    "@repo/pi-agent-ext-movie-director": "workspace:*",
    "@repo/pi-agent-ext-obsidian": "workspace:*",
    "@repo/pi-agent-ext-power-tool": "workspace:*",
    "@repo/pi-agent-ext-prompt-history": "workspace:*",
    "@repo/pi-agent-ext-research-tool": "workspace:*",
    "@repo/pi-agent-ext-superpowers": "workspace:*",
    "@repo/pi-agent-ext-wayfind": "workspace:*",
    "@repo/pi-agent-ext-web-access": "workspace:*",
    "@repo/pi-agent-ext-workflow": "workspace:*",
    "typebox": "^1.3.7"
  },
```

Extend `devDependencies` with the obfuscator (used in Task 6):

```json
  "devDependencies": {
    "@repo/pi-agent-ext-core-interface": "workspace:*",
    "@types/bun": "latest",
    "javascript-obfuscator": "^5.4.3"
  },
```

- [ ] **Step 2: Carry over the `postinstall` hook**

Add to `bun-apps/pi-agent/package.json` `scripts` (it ensures the workflow
extension's gitignored `dist/` exists — `boot-smoke.test.ts` and the workflow
commands both need it):

```json
    "postinstall": "[ -f node_modules/@repo/pi-agent-ext-workflow/dist/index.js ] || (cd node_modules/@repo/pi-agent-ext-workflow && bun run build)",
```

Do **not** copy the CLI's `cli` / `list` / `dist` / `exe` / `zk-*` scripts —
`pi-agent` already defines the first four, and the `zk-*` shortcuts are superseded
by `bun src/cli.ts cli zk-ask …`.

- [ ] **Step 3: Delete the old package**

```bash
git rm -r bun-apps/pi-agent-cli
```

Then confirm nothing is left behind (the dir may hold gitignored `node_modules/`):

```bash
rm -rf bun-apps/pi-agent-cli
[ ! -e bun-apps/pi-agent-cli ] && echo "gone"
```

Expected: `gone`

- [ ] **Step 4: Reinstall and regenerate the lockfile**

```bash
bun install --cwd bun-apps
```

Expected: succeeds; `bun-apps/bun.lock` is modified (the `@repo/pi-agent-cli`
workspace entry disappears, `@repo/pi-agent` gains the new edges).
Never commit `package-lock.json` — if one appears, delete it.

- [ ] **Step 5: Typecheck (no `tsconfig.json` edit needed)**

`bun-apps/pi-agent/tsconfig.json` already has `include: ["src/**/*.ts",
"run-dir/**/*.ts"]`, so the new `src/cli/**` tree is covered with no change. Do
**not** import the deleted package's stricter compiler options — see Deferred.

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: PASS. If it reports unresolved `@repo/pi-agent` imports, Task 2 Step 3 was
incomplete. If it reports unresolved bare `@repo/pi-agent-ext-*` specifiers, a dep is
missing from Step 1.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/package.json bun-apps/bun.lock
git add -A bun-apps/pi-agent-cli
git commit -m "refactor(pi-agent): absorb pi-agent-cli's deps, delete the package"
```

---

## Task 4: Wire the intercept

This is the one behavioral change to `pi-agent`.

**Files:**
- Modify: `bun-apps/pi-agent/src/cli.ts`
- Test: `bun-apps/pi-agent/src/cli/__tests__/e2e/meta.e2e.test.ts` (already exercises it via `_helpers.ts`)

- [ ] **Step 1: Run one moved e2e test and confirm it fails**

Run: `( cd bun-apps/pi-agent && bun test src/cli/__tests__/e2e/meta.e2e.test.ts )`
Expected: FAIL — the helper spawns `src/cli.ts cli version`, which currently falls
through to `main()` and either launches the TUI or errors, so no `version` output
appears on stdout.

- [ ] **Step 2: Add the intercept branch**

In `bun-apps/pi-agent/src/cli.ts`, extend the import on line 28 and add the branch
immediately after the `isExtDoctorCommand` block (which ends at the closing brace
before the `await applyPatches();` comment):

```ts
import {
	isDoctorCommand,
	isExtDoctorCommand,
	isCliCommand,
	userSuppressFlags,
	overriddenStaticExtensions,
} from "./cli-argv.ts";
```

```ts
// `cli <command>`: the non-interactive CLI namespace (agent commands, pipelines,
// `workflow run`, meta). Intercepted HERE, before applyPatches(), on purpose:
// the CLI curates its extension set per command (docs/adr/0001) and must NOT
// inherit the TUI's run-dir argv splice, provider patch, or static factories.
//
// The import is DYNAMIC so the TUI path never evaluates the CLI subtree — that
// subtree statically pulls flux2/krea2/ltx/movie-director through each
// extension's cli-subcommand.ts, which would otherwise land in every TUI boot.
if (isCliCommand(argv)) {
	const { runCli } = await import("./cli/dispatch.ts");
	process.exit(await runCli(argv.slice(1)));
}
```

- [ ] **Step 3: Run the same test and confirm it passes**

Run: `( cd bun-apps/pi-agent && bun test src/cli/__tests__/e2e/meta.e2e.test.ts )`
Expected: PASS.

- [ ] **Step 4: Verify the TUI path is untouched**

```bash
./pi-agent.sh --list-models | head -3
./pi-agent.sh doctor > /dev/null && echo "doctor ok"
./pi-agent.sh ext doctor > /dev/null && echo "ext doctor ok"
./pi-agent.sh cli version
```

Expected: a model table; `doctor ok`; `ext doctor ok`; then the CLI version string.
If `--list-models` regressed, the intercept was placed after `applyPatches()`.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/src/cli.ts
git commit -m "feat(pi-agent): route \`pi-agent cli <command>\` to the merged CLI dispatcher"
```

---

## Task 5: Preserve the subagent self-invocation contract

Without this, a CLI-parented subagent child lands on the TUI root and carries the
full 13-factory tool payload, silently voiding ADR 0002.

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts`
- Modify: `bun-apps/pi-agent/src/cli/dispatch.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent-subprocess.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent-subprocess.test.ts`
(import `resolvePiInvocation` at the top if it is not already imported):

```ts
describe("resolvePiInvocation entry prefix", () => {
  test("no prefix by default — child argv is unchanged", () => {
    const { args } = resolvePiInvocation(import.meta.path, "/usr/bin/bun", ["-p", "hi"]);
    expect(args).toEqual([import.meta.path, "-p", "hi"]);
  });

  test("an entry prefix is spliced between the script and the pi flags", () => {
    const { args } = resolvePiInvocation(import.meta.path, "/usr/bin/bun", ["-p", "hi"], "cli");
    expect(args).toEqual([import.meta.path, "cli", "-p", "hi"]);
  });

  test("a compiled binary (argv[1] is the $bunfs virtual path) still gets the prefix", () => {
    const { command, args } = resolvePiInvocation(
      "/$bunfs/root/pi-agent",
      "/opt/pi-agent/pi-agent",
      ["-p", "hi"],
      "cli",
    );
    expect(command).toBe("/opt/pi-agent/pi-agent");
    expect(args).toEqual(["cli", "-p", "hi"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent-subprocess.test.ts )`
Expected: FAIL — the two prefix cases get `["-p","hi"]` without `"cli"`.

- [ ] **Step 3: Implement the prefix**

In `bun-apps/pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts`, give
`resolvePiInvocation` a fourth parameter and splice it into both success branches:

```ts
export function resolvePiInvocation(
  currentScript: string | undefined,
  execPath: string,
  extra: string[],
  entryPrefix?: string,
): { command: string; args: string[] } {
  // A host whose entry namespaces its non-interactive mode behind a token (e.g.
  // pi-agent's `cli`) sets PI_SELF_ENTRY_PREFIX so the child re-enters the SAME
  // mode as the parent. Without it a CLI-parented child would land on the host's
  // default (TUI/print) entry and inherit an extension set the parent curated away.
  const prefix = entryPrefix ? [entryPrefix] : [];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: execPath, args: [currentScript, ...prefix, ...extra] };
  }
  const execName = (execPath.split(sep).pop() ?? "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: execPath, args: [...prefix, ...extra] };
  }
  throw new Error(
    `cannot self-resolve a pi entry for the subprocess subagent — refusing to fall back to a bare "pi" on PATH. ` +
      `currentScript=${currentScript ?? "(none)"} (bunVirtual=${isBunVirtual ?? false}), ` +
      `execPath=${execPath} (runtime=${execName}). ` +
      `Run via \`bun <cli.ts|bundle.js>\` or a \`bun build --compile\` binary so the child can reuse the parent's entry.`,
  );
}
```

and bind it in `getPiInvocation`:

```ts
export function getPiInvocation(extra: string[]): { command: string; args: string[] } {
  return resolvePiInvocation(
    process.argv[1],
    process.execPath,
    extra,
    process.env.PI_SELF_ENTRY_PREFIX || undefined,
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent-subprocess.test.ts )`
Expected: PASS, and every pre-existing test in that file still green (the default
path is byte-identical when the env var is unset).

- [ ] **Step 5: Set the env var from `runCli`**

In `bun-apps/pi-agent/src/cli/dispatch.ts`, as the first statement inside `runCli`:

```ts
export async function runCli(argv: string[]): Promise<number> {
	// Tell pi-agent-ext-subagent's getPiInvocation() to re-enter the `cli`
	// namespace when it spawns a child from process.argv[1]. Without this the
	// child lands on the TUI root and inherits the full static-extension set
	// this entry deliberately does not load (docs/adr/0002).
	process.env.PI_SELF_ENTRY_PREFIX = "cli";
	try {
		await dispatch(argv);
		return 0;
	} catch (e: any) {
		console.error(`error: ${e?.message ?? String(e)}`);
		return 1;
	}
}
```

- [ ] **Step 6: Verify the subagent extension's whole suite**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test )`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts \
        bun-apps/pi-agent-ext-subagent/tests/spawn-subagent-subprocess.test.ts \
        bun-apps/pi-agent/src/cli/dispatch.ts
git commit -m "fix(subagent): honor PI_SELF_ENTRY_PREFIX so a CLI-parented child re-enters the cli namespace"
```

---

## Task 6: Absorb `--obfuscate` into `deploy.ts`

**Files:**
- Modify: `bun-apps/pi-agent/scripts/deploy.ts`

- [ ] **Step 1: Register the flag**

Extend `KNOWN_FLAGS` and add the boolean, next to the existing flag parsing:

```ts
const KNOWN_FLAGS = new Set([
	"--bundle", "--snapshot", "--standalone", "--exe", "--no-freeze", "--obfuscate",
]);
```

```ts
const IS_OBFUSCATE = argv.includes("--obfuscate");
if (IS_OBFUSCATE && IS_SNAPSHOT) {
	die("✗ --obfuscate is incompatible with --snapshot (a snapshot is a raw source copy — there is no bundle to obfuscate)");
}
```

- [ ] **Step 2: Port the obfuscation stage**

Add this function next to `stageBundle` in `bun-apps/pi-agent/scripts/deploy.ts`.
It is `build.ts`'s `stageObfuscate()`, retargeted at a caller-supplied file:

```ts
// ── Stage: obfuscate (moved from the deleted pi-agent-cli/scripts/build.ts) ──
async function stageObfuscate(file: string) {
	console.log(`▶ obfuscate → ${file}`);
	const { default: JavaScriptObfuscator } = await import("javascript-obfuscator");
	const code = readFileSync(file, "utf8");
	const out = JavaScriptObfuscator.obfuscate(code, {
		compact: true,
		controlFlowFlattening: true,
		controlFlowFlatteningThreshold: 0.75,
		deadCodeInjection: true,
		deadCodeInjectionThreshold: 0.4,
		stringArray: true,
		stringArrayEncoding: ["base64"],
		stringArrayThreshold: 0.75,
		identifierNamesGenerator: "hexadecimal",
		renameGlobals: false, // keep ESM safe
		selfDefending: true,
		disableConsoleOutput: false,
		sourceMap: false,
		// javascript-obfuscator's regex transformer is brittle on non-trivial
		// patterns (obsidian carries complex wiki-link/frontmatter regexes) and
		// has crashed on them in the past, so leave regex literals intact.
		regexObfuscation: false,
	});
	writeFileSync(file, out.getObfuscatedCode());
	console.log(`  ✓ obfuscated ${file}  (${formatSize(file)})`);
}
```

- [ ] **Step 3: Wire it into both stage orders**

`--exe` currently compiles `src/cli.ts` directly and skips the bundle stage, so
`--exe --obfuscate` needs a bundle-first path. Give `stageExe` an input parameter:

```ts
async function stageExe(input: string) {
	const outfile = join(target, APP_NAME);
	console.log(`▶ compile (single-pass embed) → ${outfile}`);
	clean(outfile);

	const externalFlags = OPTIONAL_EXTERNALS.flatMap((p) => ["--external", p]);
	const proc = Bun.spawn(
		["bun", "build", "--compile", input, `--outfile=${outfile}`, "--minify", ...externalFlags],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	if (code !== 0) die(`  ✗ bun build --compile exited ${code}`);
	console.log(`  ✓ ${outfile}  (${formatSize(outfile)})`);
}
```

and in `main()`, replace the `if (IS_EXE) { await stageExe(); }` branch and add the
obfuscate call to the bundle branch:

```ts
	if (IS_EXE) {
		// --exe: compile directly from source, skip ext-bundles/skills/run.sh.
		// With --obfuscate we must bundle first, obfuscate that bundle, then
		// compile IT — mirrors the deleted build.ts's `--all` stage order.
		if (IS_OBFUSCATE) {
			await stageBundle(piPkgDir);
			const bundled = join(target, `${APP_NAME}.js`);
			await stageObfuscate(bundled);
			await stageExe(bundled);
			rmSync(bundled);
		} else {
			await stageExe("src/cli.ts");
		}
	} else if (IS_SNAPSHOT) {
		await stageSnapshot(bunAppsDir);
	} else {
		await stageBundle(piPkgDir);
		if (IS_OBFUSCATE) await stageObfuscate(join(target, `${APP_NAME}.js`));
		// … existing ext-bundles / skills / run.sh stages unchanged …
```

- [ ] **Step 4: Update the usage header**

In the `deploy.ts` file header comment, add the flag to the USAGE block:

```
 *   bun scripts/deploy.ts [out-dir] --obfuscate     # + javascript-obfuscator on the bundle
 *                                                   #   (with --exe: bundle → obfuscate → compile)
 *                                                   #   (rejected with --snapshot)
```

- [ ] **Step 5: Verify the default deploy path is unchanged**

Run: `bun run --cwd bun-apps/pi-agent deploy`
Expected: same output shape as before this task — `▶ bundle → …`, thin ext bundles,
skills, `run.sh`, freeze. No `▶ obfuscate` line.

- [ ] **Step 6: Verify the new flag works**

Run: `bun run --cwd bun-apps/pi-agent deploy -- --obfuscate`
Expected: an extra `▶ obfuscate → …/pi-agent.js` line, and the deploy still boots:

```bash
bun dist/pi-agent/pi-agent.js --list-models > /dev/null && echo "obfuscated bundle boots"
```

Expected: `obfuscated bundle boots`. If `javascript-obfuscator` crashes on a regex,
that is the known failure mode the `regexObfuscation: false` option guards against —
confirm the option is present before investigating further.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/scripts/deploy.ts
git commit -m "feat(pi-agent): absorb the obfuscate build tier into deploy.ts as --obfuscate"
```

---

## Task 7: Prove the compiled binary carries the CLI subtree

The spec flags this as the one thing that must be measured, not assumed: `--exe`
runs `bun build --compile src/cli.ts`, and the CLI is reached through a literal
dynamic `import()`. Bun normally embeds those, but `static-extensions.ts` documents
a sibling trap where a literal `require()` survived bundling as a real runtime call
and crashed the binary.

**Files:**
- Possibly modify: `bun-apps/pi-agent/src/cli.ts` (fallback only)

- [ ] **Step 1: Build the binary**

Run: `bun run --cwd bun-apps/pi-agent deploy:exe`
Expected: `✓ …/dist/pi-agent/pi-agent (<size>)`. Note the size — the CLI subtree
should make it visibly larger than before this change.

- [ ] **Step 2: Probe the CLI namespace inside the binary**

```bash
dist/pi-agent/pi-agent cli version
dist/pi-agent/pi-agent cli help
dist/pi-agent/pi-agent doctor --smoke
```

Expected: a version string, the CLI root help listing every command group, and the
smoke probe passing. A `Cannot find module ./cli/dispatch.ts from '/$bunfs/root/…'`
means the dynamic import was NOT embedded — go to Step 3. Anything else passing
means Step 3 is skipped entirely.

- [ ] **Step 3 (ONLY if Step 2 failed): apply the static-import fallback**

Replace the dynamic import in `bun-apps/pi-agent/src/cli.ts` with a static one.
This costs the TUI the CLI subtree's import time on every boot, which is why it is
the fallback and not the default — record the measured TUI startup delta in the
commit message.

```ts
// NOTE: a static import, not `await import()`. Bun's --compile did not embed the
// dynamic form (verified: `Cannot find module ./cli/dispatch.ts from /$bunfs/root`),
// the same class of failure static-extensions.ts documents for literal require().
// Cost: the TUI now evaluates the CLI subtree on every boot.
import { runCli } from "./cli/dispatch.ts";
```

```ts
if (isCliCommand(argv)) {
	process.exit(await runCli(argv.slice(1)));
}
```

Then re-run Step 1 and Step 2.

- [ ] **Step 4: Re-verify the TUI still works from the binary**

```bash
dist/pi-agent/pi-agent --list-models > /dev/null && echo "binary TUI ok"
```

Expected: `binary TUI ok`

- [ ] **Step 5: Commit (only if Step 3 was needed; otherwise nothing changed)**

```bash
git add bun-apps/pi-agent/src/cli.ts
git commit -m "fix(pi-agent): statically import the cli dispatcher so --exe embeds it"
```

If Step 2 passed outright, record the result in the next task's commit message
instead — there is nothing to commit here.

---

## Task 8: Update the external references

Nine files outside the deleted package plus `CLAUDE.md`.

**Files:**
- Modify: `scripts/verify-deploy.sh`
- Modify: `scripts/iter4-measure.mjs`, `scripts/live-zk-ask-measure.mjs`
- Modify: `bun-apps/pi-agent/run-dir/workflows/verify-bun-pi-agent-cli.js`
- Modify: `bun-apps/pi-agent/run-test.sh`
- Modify: `bun-apps/pi-agent-ext-devops/src/schema-cost-check.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`
- Modify: `bun-apps/tests/dep-guard.test.ts`
- Modify: `docs/benchmarks/verify-bun-pi-agent-cli/compare.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `workflow-pack.test.ts` — the hard break first**

At line ~529, `CLI_WORKFLOWS` points at the real example packs, which have moved:

```ts
  // The "real pack" destination-proof tests point at the example packs that now
  // live in pi-agent (bun-apps/pi-agent/workflows/). From this test dir that is
  // ../../pi-agent/workflows/<pack>.
  const CLI_WORKFLOWS = resolve(import.meta.dirname, "../../pi-agent/workflows");
```

At lines ~635 and ~641 the path is synthesized inside a tmpdir, so it is cosmetic —
rename both together so the assertion keeps matching:

```ts
    const wfDir = join(root, "bun-apps", "pi-agent", "workflows");
```
```ts
    expect(row.source).toBe("bun-apps/pi-agent/workflows");
```

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: PASS.

- [ ] **Step 2: `dep-guard.test.ts` — rename the host**

At line ~146:

```ts
	it("no extension imports the host (pi-agent) — the host sits above all extensions", () => {
		const violations = EXTS.filter((pkg) => edges(pkg).has("pi-agent"));
		assert.deepEqual(violations, [], `extensions importing the host: ${violations.join(", ")}`);
	});
```

Also update the file-header comment at line ~18:

```
 *  5. No extension imports the host (pi-agent) — the host is above all exts.
```

Run: `( cd bun-apps && bun test tests/dep-guard.test.ts )`
Expected: PASS. A failure here means an extension declares `@repo/pi-agent` as a
dep — find it and remove the edge; the host must stay above every extension.

- [ ] **Step 3: `schema-cost-check.ts` — path + `cli` token**

Line ~80:

```ts
	const CLI = `${root}/bun-apps/pi-agent/src/cli.ts`;
```

Line ~85, in `collectLive()`:

```ts
		const r = await spawn("bun", [CLI, "cli", "tools-metrics", "--schema-cost", "--json"], { cwd: root });
```

Line ~134, the operator-facing hint:

```ts
		console.warn("    bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --schema-cost --json \\");
```

Run: `( cd bun-apps/pi-agent-ext-devops && bun test )`
Expected: PASS. Its tests inject a mock `SpawnFn`, so they assert the argv shape —
if one fails on the added `"cli"` element, update that expectation to match.

- [ ] **Step 4: `verify-deploy.sh` — collapse two artifacts into one, and fix the pre-existing bug**

Step 3a currently runs `bun-apps/pi-agent/scripts/build.ts`, **which does not
exist** — `pi-agent` only has `deploy.ts`. That line is already broken today.
Replace the whole of steps 2, 3 and 4 (lines ~62-95) with:

```bash
# ── 2. unit tests ────────────────────────────────────────────────────────────
step "unit tests" "(pi-agent, no GPU/model)"
( cd bun-apps/pi-agent && bun test >/tmp/vd-pi-agent.log 2>&1 ) \
  || { tail -8 /tmp/vd-pi-agent.log; fail "pi-agent tests" "step 2"; }
ok "pi-agent: $(grep -E '^\s+[0-9]+ pass' /tmp/vd-pi-agent.log | tail -1 | xargs)"

# ── 3. bundle ────────────────────────────────────────────────────────────────
# (was two builds; pi-agent-cli is merged in, and step 3a used to call a
#  scripts/build.ts that never existed in pi-agent.)
step "bundle" "(proves all workspace imports resolve)"
( cd bun-apps/pi-agent && bun scripts/deploy.ts --no-freeze >/tmp/vd-build-agent.log 2>&1 ) \
  || { tail -10 /tmp/vd-build-agent.log; fail "pi-agent deploy --bundle" "step 3"; }
ok "pi-agent bundle ($(du -h dist/pi-agent/pi-agent.js | cut -f1))"

# ── 4. smoke (boot the built artifact, both entry modes) ─────────────────────
step "smoke" "(built artifact boots + responds)"
[ -f dist/pi-agent/pi-agent.js ] || fail "pi-agent.js missing" "step 4"
bun dist/pi-agent/pi-agent.js --list-models >/dev/null 2>&1 \
  || fail "pi-agent --list-models" "step 4a"
MODELS="$(bun dist/pi-agent/pi-agent.js --list-models 2>/dev/null | grep -c '^' || true)"
ok "pi-agent --list-models ($MODELS rows)"

bun dist/pi-agent/pi-agent.js cli version >/dev/null 2>&1 \
  || fail "pi-agent cli version" "step 4b"
ok "pi-agent cli version"
```

- [ ] **Step 5: `run-test.sh` — drop the removed package from the sibling loop**

Line ~227:

```bash
		for pkg in pi-obsidian pi-knowledge-card pi-agent-ext-file2md; do
```

- [ ] **Step 6: The three remaining path-only references**

`bun-apps/pi-agent/run-dir/workflows/verify-bun-pi-agent-cli.js` line ~29:

```js
  cliPkg: A.cliPkg ?? 'bun-apps/pi-agent',
```

`scripts/live-zk-ask-measure.mjs` line ~44:

```js
const CLI_DIR = join(REPO, "bun-apps/pi-agent");
```

`scripts/iter4-measure.mjs` line ~90:

```js
			`OB_VAULT_PATH='${VAULT}' bun --cwd '${ROOT}/bun-apps/pi-agent' src/cli.ts cli zk-ask '${esc}' ` +
```

Then sweep the same two measurement scripts and
`docs/benchmarks/verify-bun-pi-agent-cli/compare.ts` for any other
`src/cli.ts <command>` invocation that now needs the `cli` token:

```bash
grep -rn "src/cli.ts" scripts/iter4-measure.mjs scripts/live-zk-ask-measure.mjs \
  docs/benchmarks/verify-bun-pi-agent-cli/compare.ts \
  bun-apps/pi-agent/run-dir/workflows/verify-bun-pi-agent-cli.js
```

Every hit that targets a CLI command (not the TUI) must read
`src/cli.ts cli <command>`.

- [ ] **Step 7: `CLAUDE.md` — two stale pointers**

In the "Extension packages" section, the schema-cost canary bullet:

```
- **Schema-cost canary**: `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` `discoverExtensionEntries()` derives its list from `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]` + `staticExtensions[]`) — extensions registered there are measured automatically. Only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
- **CLI subcommands**: extension-backed CLI subcommands live at `extensions/cli-subcommand.ts` and are wired in `bun-apps/pi-agent/src/cli/extensions/registry.ts`.
```

In the "Active stack" / "Testing" sections, replace any `bun-apps/pi-agent-cli`
invocation with `bun-apps/pi-agent` + the `cli` token.

- [ ] **Step 8: Confirm no live reference survives**

```bash
grep -rn "pi-agent-cli" --include="*.ts" --include="*.js" --include="*.sh" \
  --include="*.mjs" --include="*.json" --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=workflows_archive --exclude-dir=dist . \
  | grep -vE "^\./\.planning" | grep -vE "^[^:]+:[0-9]+: *\*"
```

Expected: no output, **except** prose mentions inside doc-comments (which are fine
if they read as history, and should be reworded if they read as instructions) and
the `verify-bun-pi-agent-cli.js` filename itself, which stays as-is — renaming the
workflow pack is out of scope.

- [ ] **Step 9: Commit**

```bash
git add scripts/ bun-apps/pi-agent/run-test.sh bun-apps/pi-agent/run-dir/workflows/ \
        bun-apps/pi-agent-ext-devops/ bun-apps/pi-agent-ext-workflow/tests/ \
        bun-apps/tests/dep-guard.test.ts docs/benchmarks/ CLAUDE.md
git commit -m "refactor: repoint every pi-agent-cli reference at \`pi-agent cli\`"
```

---

## Task 9: Merge the domain docs

One domain, one `CONTEXT.md` (see `docs/agents/domain.md`).

**Files:**
- Modify: `bun-apps/pi-agent/CONTEXT.md`
- Modify: `bun-apps/pi-agent/README.md`
- Modify: `bun-apps/pi-agent/docs/adr/0005-provider-catalog-from-pi-agent.md`

- [ ] **Step 1: Fold the CLI vocabulary into `pi-agent/CONTEXT.md`**

The source text is at `bun-apps/pi-agent/docs/_cli-CONTEXT.md` (staged there by
Task 2 Step 1). Append a `## Non-interactive CLI` section to
`bun-apps/pi-agent/CONTEXT.md` carrying over every term from it, keeping each
`_Avoid_:` note intact:

- Execution model: **Non-interactive run**, **Single-turn agent run**
- Extension loading: **Baked-in extension**, **Always-on extension**, **Per-command extension**
- Invocation dispatch: **Command**, **Agent command**, **Pipeline**, **Workflow sub-command**, **Workflow pack**, **Workflow-pack resolution precedence**, **Meta command**, **Passthrough**, **Sub-agent target**
- Knowledge distillation: **Distill pipeline**, **Gate**, **Enrich**, **Converge**, **Adaptive threshold**
- Knowledge retrieval: **Deterministic retrieval**, **Graph-enhanced RAG**

Add one new term at the top of that section:

```markdown
**`cli` namespace**:
The argv token that routes into the non-interactive CLI (`pi-agent cli <command>`).
Intercepted in `src/cli.ts` BEFORE `applyPatches()`, so a CLI invocation inherits
none of the TUI's run-dir splice, provider patch, or static extension factories —
that separation is what keeps per-command tool curation (ADR 0001) meaningful.
_Avoid_: subcommand (ambiguous), mode (it is an entry namespace, not a runtime mode)
```

And amend the **Sub-agent target** entry to name the mechanism:

```markdown
**Sub-agent target**:
A binary that its own extensions can re-invoke as a child agent run (via
`process.argv[1]` + pi flags). pi-agent is its own sub-agent target. When the
parent is in the `cli` namespace, `runCli()` exports `PI_SELF_ENTRY_PREFIX=cli`
so `getPiInvocation()` puts the child in the same namespace instead of the TUI root.
```

- [ ] **Step 2: Update `pi-agent/README.md`**

Add a "Non-interactive CLI" section documenting the namespace, and replace the
"Related → pi-agent-cli" cross-link (it now points at a deleted package). Carry over
the command tables from `bun-apps/pi-agent/docs/_cli-README.md` (staged by Task 2
Step 1), rewriting every invocation:

```
bun run --cwd bun-apps/pi-agent cli cli zk-ask "How does Bun handle workspaces?"
```

is confusing (the `cli` npm script plus the `cli` token), so document the direct form:

```bash
bun bun-apps/pi-agent/src/cli.ts cli zk-ask "How does Bun handle workspaces?"
./pi-agent.sh cli zk-ask "How does Bun handle workspaces?"
```

- [ ] **Step 3: Update ADR 0005**

`docs/adr/0005-provider-catalog-from-pi-agent.md` describes a cross-package
dependency that no longer exists. Add a status note at the top rather than deleting
the ADR — the decision still holds, its mechanism just got simpler:

```markdown
> **Amended 2026-08-11 (pi-agent-cli merge).** The CLI now lives inside `pi-agent`
> (`src/cli/`), so the catalog is reached by a relative import
> (`src/cli/sessions/shared.ts` → `../../pre-load-providers.ts`) instead of the
> `@repo/pi-agent` workspace dependency. The invariant is unchanged and now
> structurally enforced: there is exactly one `PROVIDERS` catalog, in one package.
```

- [ ] **Step 4: Remove the staging files**

Both `_`-prefixed files have now been consumed:

```bash
git rm bun-apps/pi-agent/docs/_cli-CONTEXT.md bun-apps/pi-agent/docs/_cli-README.md
```

`docs/cli-PRD.md` and `docs/cli-VERIFICATION.md` stay — they are the CLI's own
product/verification records and have no merge target.

- [ ] **Step 5: Commit**

```bash
git add -A bun-apps/pi-agent/CONTEXT.md bun-apps/pi-agent/README.md bun-apps/pi-agent/docs/
git commit -m "docs(pi-agent): merge the CLI's CONTEXT vocabulary, README, and ADR 0005 amendment"
```

---

## Task 10: Full acceptance run

No code changes — this is the spec's acceptance gate, executed end to end. If any
step fails, fix it and re-run the whole task.

- [ ] **Step 1: Clean install**

```bash
bun install --cwd bun-apps
```

Expected: succeeds, no `package-lock.json` created.

- [ ] **Step 2: Both suites**

```bash
( cd bun-apps/pi-agent && bun test )
bun run --cwd bun-apps/pi-agent typecheck
```

Expected: all green. `pi-agent`'s 30 pre-existing test files and the 29 moved ones
now run together. **A pre-existing failure is not acceptable cover** — if something
red was already red before this branch, fix it or state explicitly why it is out of
scope, per the repo's fix-baseline-first convention.

- [ ] **Step 3: The touched sibling packages**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun test )
( cd bun-apps/pi-agent-ext-subagent && bun test )
( cd bun-apps/pi-agent-ext-devops && bun test )
( cd bun-apps && bun test tests/dep-guard.test.ts )
```

Expected: all green.

- [ ] **Step 4: The launcher contract — nothing may have changed**

```bash
./pi-agent.sh --list-models | head -3
./pi-agent.sh doctor
./pi-agent.sh ext doctor
```

Expected: identical behavior to `main`. If you want a hard check, capture the same
three outputs from a `git stash`ed tree first and diff them.

- [ ] **Step 5: The new namespace**

```bash
./pi-agent.sh cli version
./pi-agent.sh cli help
./pi-agent.sh cli doctor
./pi-agent.sh cli workflow list
```

Expected: version string; root help listing agent commands / pipelines / workflow /
meta; the cross-machine checklist; and the workflow-pack table including the `echo`,
`args-demo` and `sample` packs now resolved from `bun-apps/pi-agent/workflows`.

- [ ] **Step 6: Deploy, both artifacts**

```bash
bun run --cwd bun-apps/pi-agent deploy
bun dist/pi-agent/pi-agent.js --list-models > /dev/null && echo "bundle TUI ok"
bun dist/pi-agent/pi-agent.js cli version && echo "bundle CLI ok"

bun run --cwd bun-apps/pi-agent deploy:exe
dist/pi-agent/pi-agent doctor --smoke
dist/pi-agent/pi-agent cli version && echo "binary CLI ok"
```

Expected: `bundle TUI ok`, `bundle CLI ok`, the smoke probe passing, `binary CLI ok`.

- [ ] **Step 7: The full verify script**

```bash
bash scripts/verify-deploy.sh
```

Expected: every step green, including the new `pi-agent cli version` smoke.

- [ ] **Step 8: The package is really gone**

```bash
[ ! -e bun-apps/pi-agent-cli ] && echo "package deleted"
grep -c "pi-agent-cli" bun-apps/bun.lock || echo "0 lockfile references"
```

Expected: `package deleted`, and no `@repo/pi-agent-cli` workspace entry in the
lockfile.

- [ ] **Step 9: Commit any fixes and update the effort docs**

```bash
git add -A
git commit -m "chore(pi-agent): acceptance-run fixes for the pi-agent-cli merge"
git add .planning/2026-08-11-merge-pi-agent-cli-into-pi-agent/
git commit -m "docs(planning): mark the pi-agent-cli merge plan complete"
```

---

## Deferred (explicitly out of scope)

Do not do these in this branch:

- Adopting the CLI's stricter tsconfig flags (`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) in
  `pi-agent`. Tightening would mix an unrelated batch of type errors into a
  move-only change. File a follow-up ticket.
- Unifying session construction (spec's rejected "approach B"): deleting
  `src/cli/sessions/shared.ts`'s own provider registration and baked-in factories in
  favour of `STATIC_EXTENSION_FACTORIES`. This overturns ADR 0001 and raises the
  per-invocation token cost of every CLI command.
- Renaming the `verify-bun-pi-agent-cli` workflow pack.
- Pruning any CLI command, pipeline, or extension sub-command.
