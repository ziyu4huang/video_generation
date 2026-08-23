# User `-ne` / `-ns` Flag Honoring + Customization-Layer Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user-passed `-ne`/`--no-extensions` and `-ns`/`--no-skills` actually suppress pi-agent's injected extensions/skills (today they are silently defeated by the run-dir argv splice and the ungated static factories), and clean up the customization layer: manifest-derived extension lists in pi-agent-cli, de-duplicated command tables, consistent patch file naming, and truthful docs.

**Architecture:** pi-agent wraps upstream `pi` and injects its extension set through two channels: (1) `src/patches/load-run-dir-resources.ts` splices absolute `-e`/`--skill` paths into `process.argv`, and (2) `src/cli.ts` passes `STATIC_EXTENSION_FACTORIES` to `main()`. Upstream pi's `-ne` only skips *discovered* (`.pi/`) extensions — explicit CLI `-e` paths and inline factories always load (empirically verified against vendored `resource-loader.js`). The fix reads the **pre-patch** argv (already captured in `cli.ts` before `applyPatches()` runs) to distinguish user-passed `-ne`/`-ns` from the `-ne` that deploy layouts inject internally, then gates both injection channels on it. pi-agent-cli's hard-coded extension list in `schema-cost.ts` is replaced by derivation from pi-agent's `run-dir/manifest.json` so modifying an extension no longer requires a CLI edit.

**Tech Stack:** Bun + TypeScript, `bun test`, vendored `@earendil-works/pi-coding-agent` (never edited — behavior changed only via pi-agent's own wrapper/patch files).

**Key upstream facts (verified 2026-07-19, pi-coding-agent 0.80.10):**
- `dist/cli/args.js:124` — `"--no-extensions" || "-ne"` → `noExtensions`; `:139` — `"--no-skills" || "-ns"` → `noSkills`.
- `dist/core/resource-loader.js:267-269` — `noExtensions` keeps CLI `-e` paths, drops only discovered ones. Same shape for skills at `:281-283`.
- `dist/core/resource-loader.js:366-373` — `extensionFactories` load **unconditionally** (not gated by `noExtensions`). Verified at runtime: a dummy factory loads even with `noExtensions: true`.
- Therefore: after this plan, `pi-agent -ne` = zero pi-agent-injected extensions (user's own explicit `-e <path>` still loads — this matches upstream pi semantics exactly and is intentional).
- Deploy layouts (`deploy-bundle` / `deploy-package`) intentionally self-inject `-ne` (`run-dir/resolve.ts:399,415`) to ignore cwd `.pi/`. That behavior must NOT change. The user-vs-injected distinction is safe because `cli.ts` captures `argv` at line 46 **before** `applyPatches()` splices anything, and `load-run-dir-resources.ts` runs during `applyPatches()` when `process.argv` is still the unspliced user argv.

**Repo state note:** the session starts on a detached HEAD with a clean tree. Task 0 creates a working branch off `origin/main` first (per repo SOP: always `git fetch` + `checkout -b`, never `git branch <name> <sha>`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `bun-apps/pi-agent/src/cli-argv.ts` | Modify | + `userSuppressFlags()` — pure pre-patch argv classification (one home for all pre-patch argv decisions, alongside `isDoctorCommand`) |
| `bun-apps/pi-agent/src/cli-argv.test.ts` | Modify | + tests for `userSuppressFlags` |
| `bun-apps/pi-agent/run-dir/resolve.ts` | Modify | + `suppressResolvedArgv()` pure filter; `resolveRunDirArgv(userFlags?)` optional param |
| `bun-apps/pi-agent/run-dir/resolve.test.ts` | Modify | + tests for filter + integration |
| `bun-apps/pi-agent/src/patches/load-run-dir-resources.ts` | Modify | compute user flags from pre-splice argv, pass to `resolveRunDirArgv` |
| `bun-apps/pi-agent/src/cli.ts` | Modify | gate `STATIC_EXTENSION_FACTORIES` on user `-ne` |
| `bun-apps/pi-agent/src/static-extensions.test.ts` | Create | sync guard: factory names == `manifest.staticExtensions` |
| `bun-apps/pi-agent/src/patches/pre-load-providers.ts` | Rename from `pre-load-providers-patch.ts` | naming consistency (only patch file with a `-patch` suffix; `patches/` dir already says it) |
| `bun-apps/pi-agent/src/patches/index.ts` | Modify | import path for the rename |
| `bun-apps/pi-agent/src/pre-load-providers.ts` | Modify | two comment references to the renamed file |
| `bun-apps/pi-agent/README.md` | Modify | fix stale "5 static extensions" counts; document `-ne`/`-ns` semantics |
| `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` | Modify | derive `discoverExtensionEntries()` from pi-agent manifest + small EXTRA list |
| `bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts` | Modify | + derivation tests |
| `bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json` | Modify | re-baseline after coverage grows |
| `bun-apps/pi-agent-cli/src/commands/sessions.ts`, `memory.ts` | Modify | add missing `name` field |
| `bun-apps/pi-agent-cli/src/cli.ts` | Modify | COMMANDS/PIPELINES/WORKFLOWS reference command objects directly (~100 lines of boilerplate removed) |
| `CLAUDE.md` | Modify | delete the now-obsolete "schema-cost canary curated list" caveat |

All `bun test` invocations for pi-agent run as `( cd bun-apps/pi-agent && bun test <file> )`; for pi-agent-cli as `( cd bun-apps/pi-agent-cli && bun test <file> )`. Never top-level `cd` (repo hook blocks it).

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Sync and branch off origin/main**

```bash
git fetch origin
git checkout -b feat/ne-ns-user-flags origin/main
```

Expected: `Switched to a new branch 'feat/ne-ns-user-flags'`. Verify with `git status` → clean, on `feat/ne-ns-user-flags`.

---

### Task 1: `userSuppressFlags()` — pure user-argv classifier

**Files:**
- Modify: `bun-apps/pi-agent/src/cli-argv.ts`
- Test: `bun-apps/pi-agent/src/cli-argv.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/cli-argv.test.ts` (import line becomes `import { isDoctorCommand, isExtDoctorCommand, userSuppressFlags } from "./cli-argv.ts";`):

```ts
describe("userSuppressFlags", () => {
	test("-ne / --no-extensions set noExtensions", () => {
		expect(userSuppressFlags(["-ne"])).toEqual({ noExtensions: true, noSkills: false });
		expect(userSuppressFlags(["--no-extensions", "-p", "hi"])).toEqual({
			noExtensions: true,
			noSkills: false,
		});
	});

	test("-ns / --no-skills set noSkills", () => {
		expect(userSuppressFlags(["-ns"])).toEqual({ noExtensions: false, noSkills: true });
		expect(userSuppressFlags(["--no-skills"])).toEqual({ noExtensions: false, noSkills: true });
	});

	test("both flags combine; empty argv is all-false", () => {
		expect(userSuppressFlags(["-ne", "-ns"])).toEqual({ noExtensions: true, noSkills: true });
		expect(userSuppressFlags([])).toEqual({ noExtensions: false, noSkills: false });
	});

	test("matches pi's own parser: token anywhere in argv counts", () => {
		// pi's args.js treats `-ne` as a flag wherever it appears (prompts are
		// positional), so plain includes() mirrors upstream semantics exactly.
		expect(userSuppressFlags(["-p", "hello", "-ne"]).noExtensions).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: FAIL — `userSuppressFlags` is not exported.

- [ ] **Step 3: Implement** — append to `src/cli-argv.ts`:

```ts
/**
 * User-passed suppression flags, read from the PRE-PATCH argv (the slice
 * cli.ts captures before applyPatches() splices run-dir `-e`/`--skill` paths
 * in). This is what distinguishes a USER's `-ne` from the `-ne` that deploy
 * layouts self-inject inside resolveRunDirArgv() — at classification time the
 * injected tokens don't exist yet.
 *
 * Upstream pi treats these tokens as flags wherever they appear in argv
 * (dist/cli/args.js), so a plain includes() mirrors pi exactly.
 */
export interface UserSuppressFlags {
	noExtensions: boolean;
	noSkills: boolean;
}

export function userSuppressFlags(argv: string[]): UserSuppressFlags {
	return {
		noExtensions: argv.includes("-ne") || argv.includes("--no-extensions"),
		noSkills: argv.includes("-ns") || argv.includes("--no-skills"),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/cli-argv.test.ts )`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/src/cli-argv.ts bun-apps/pi-agent/src/cli-argv.test.ts
git commit -m "feat(pi-agent): add userSuppressFlags pre-patch argv classifier for -ne/-ns"
```

---

### Task 2: `suppressResolvedArgv()` — pure filter for run-dir-injected argv

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/resolve.ts`
- Test: `bun-apps/pi-agent/run-dir/resolve.test.ts`

- [ ] **Step 1: Write the failing test** — append to `run-dir/resolve.test.ts` (add `suppressResolvedArgv` to the existing `./resolve.ts` import):

```ts
describe("suppressResolvedArgv", () => {
	const argv = ["-ne", "-e", "/a/ext.ts", "--skill", "/a/skills", "-e", "/b/ext.js"];

	test("noExtensions strips -e pairs, keeps --skill and bare -ne", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true })).toEqual([
			"-ne",
			"--skill",
			"/a/skills",
		]);
	});

	test("noSkills strips --skill pairs only", () => {
		expect(suppressResolvedArgv(argv, { noSkills: true })).toEqual([
			"-ne",
			"-e",
			"/a/ext.ts",
			"-e",
			"/b/ext.js",
		]);
	});

	test("both flags leave only the bare -ne marker; no flags is identity", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true, noSkills: true })).toEqual(["-ne"]);
		expect(suppressResolvedArgv(argv, {})).toEqual(argv);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test run-dir/resolve.test.ts )`
Expected: FAIL — `suppressResolvedArgv` not exported.

- [ ] **Step 3: Implement** — add to `run-dir/resolve.ts` (below `buildArgvFromManifest`):

```ts
/**
 * Drop `-e <path>` / `--skill <path>` pairs from a RUN-DIR-RESOLVED argv
 * fragment according to user-passed suppression flags (see
 * src/cli-argv.ts userSuppressFlags). Only ever applied to the argv THIS
 * module produced — the user's own `-e <path>` flags live elsewhere in
 * process.argv and are untouched, which matches upstream pi's `-ne`
 * semantics (explicit CLI extensions still load under -ne).
 * Bare tokens (the deploy modes' self-injected "-ne") pass through.
 */
export function suppressResolvedArgv(
	argv: string[],
	flags: { noExtensions?: boolean; noSkills?: boolean },
): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]!;
		if (flags.noExtensions && (tok === "-e" || tok === "--extension")) {
			i++; // skip payload
			continue;
		}
		if (flags.noSkills && tok === "--skill") {
			i++; // skip payload
			continue;
		}
		out.push(tok);
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test run-dir/resolve.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/run-dir/resolve.ts bun-apps/pi-agent/run-dir/resolve.test.ts
git commit -m "feat(pi-agent): add suppressResolvedArgv filter for run-dir argv"
```

---

### Task 3: Thread user flags through `resolveRunDirArgv` and the splice patch

**Files:**
- Modify: `bun-apps/pi-agent/run-dir/resolve.ts:338` (signature + return points)
- Modify: `bun-apps/pi-agent/src/patches/load-run-dir-resources.ts`
- Test: `bun-apps/pi-agent/run-dir/resolve.test.ts`

- [ ] **Step 1: Write the failing integration test** — append inside the existing `describe("resolveRunDirArgv (integration, source mode against the real repo)")` block:

```ts
	test("user -ne/-ns suppress the injected -e/--skill pairs", async () => {
		const suppressed = await resolveRunDirArgv({ noExtensions: true, noSkills: true });
		expect(suppressed).not.toContain("-e");
		expect(suppressed).not.toContain("--skill");

		// -ne alone keeps skills flowing
		const extOnly = await resolveRunDirArgv({ noExtensions: true });
		expect(extOnly).not.toContain("-e");
		expect(extOnly).toContain("--skill");

		// default (no flags) is unchanged
		const full = await resolveRunDirArgv();
		expect(full).toContain("-e");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test run-dir/resolve.test.ts )`
Expected: FAIL — `resolveRunDirArgv` takes no argument yet (TS error or suppressed argv still contains `-e`).

- [ ] **Step 3: Implement** — in `run-dir/resolve.ts`, rename the existing exported function body and add a thin filtered wrapper. Change:

```ts
/** Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...] */
export async function resolveRunDirArgv(): Promise<string[]> {
```

to:

```ts
/**
 * Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...],
 * filtered by user-passed `-ne`/`-ns` (userFlags — computed by the caller from
 * the PRE-SPLICE argv, see src/patches/load-run-dir-resources.ts). The deploy
 * modes' own self-injected "-ne" is a bare token and survives the filter.
 */
export async function resolveRunDirArgv(
	userFlags: { noExtensions?: boolean; noSkills?: boolean } = {},
): Promise<string[]> {
	return suppressResolvedArgv(await resolveRunDirArgvUnfiltered(), userFlags);
}

async function resolveRunDirArgvUnfiltered(): Promise<string[]> {
```

(The old function body — from the `if (mode === "binary")` guard through the final `return argv;` — moves verbatim into `resolveRunDirArgvUnfiltered`. No other body edits.)

Then replace `src/patches/load-run-dir-resources.ts` lines 13-21 with:

```ts
import { resolveRunDirArgv, rewriteArgvLazyExtensions } from "../../run-dir/resolve.ts";
import { userSuppressFlags } from "../cli-argv.ts";

// process.argv is still the UNSPLICED user argv at this point (this patch is
// what does the splicing), so the flags read here are exactly what the user
// typed — the deploy modes' self-injected "-ne" hasn't been added yet.
const userFlags = userSuppressFlags(process.argv.slice(2));
const extra = await resolveRunDirArgv(userFlags);

if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
  console.error("[bun-pi] run-dir resolved argv:", extra);
}

process.argv.splice(2, 0, ...extra);
```

(The trailing `rewriteArgvLazyExtensions(process.argv)` call at the bottom of the file stays unchanged — under `-ne` a user's explicit `-e workflow` alias must still resolve, matching pi's "explicit CLI extensions load under -ne" semantics.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent && bun test run-dir/resolve.test.ts src/cli-argv.test.ts )`
Expected: PASS, including the pre-existing integration tests (no-arg call unchanged).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/run-dir/resolve.ts bun-apps/pi-agent/src/patches/load-run-dir-resources.ts bun-apps/pi-agent/run-dir/resolve.test.ts
git commit -m "feat(pi-agent): honor user -ne/-ns in the run-dir argv splice"
```

---

### Task 4: Gate static extension factories on user `-ne`

**Files:**
- Modify: `bun-apps/pi-agent/src/cli.ts:27-28,80`

- [ ] **Step 1: Implement** (no unit seam here — cli.ts is a side-effect entry point; the decision logic is already unit-tested in Task 1, and Step 2 verifies end-to-end). In `src/cli.ts` change the import:

```ts
import { isDoctorCommand, isExtDoctorCommand, userSuppressFlags } from "./cli-argv.ts";
```

and change the final `main()` call (line 80) from:

```ts
await main(process.argv.slice(2), { extensionFactories: STATIC_EXTENSION_FACTORIES });
```

to:

```ts
// `argv` was sliced BEFORE applyPatches(), so this reflects only what the USER
// typed — the deploy modes' self-injected "-ne" (spliced during applyPatches)
// can't turn the static factories off. Upstream pi never gates
// extensionFactories on -ne (resource-loader loads them unconditionally), so
// this gate is what makes `pi-agent -ne` actually mean "no injected extensions".
const userNoExtensions = userSuppressFlags(argv).noExtensions;
await main(process.argv.slice(2), {
	extensionFactories: userNoExtensions ? [] : STATIC_EXTENSION_FACTORIES,
});
```

- [ ] **Step 2: End-to-end verification (source mode)**

```bash
( cd bun-apps/pi-agent && BUN_PI_DEBUG_RUN_DIR=1 bun src/cli.ts -ne -ns --list-models 2>&1 | grep "run-dir resolved argv" )
```

Expected: `[bun-pi] run-dir resolved argv: []` (no `-e`, no `--skill`). Then confirm the default path still injects:

```bash
( cd bun-apps/pi-agent && BUN_PI_DEBUG_RUN_DIR=1 bun src/cli.ts --list-models 2>&1 | grep -c '"-e"\|-e' )
```

Expected: the debug line lists the manifest `-e` paths (non-empty argv array).

- [ ] **Step 3: Run the full pi-agent suite (regression gate)**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS (same pass/fail set as on `origin/main`).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/src/cli.ts
git commit -m "feat(pi-agent): user -ne disables static extension factories"
```

---

### Task 5: Sync guard — `STATIC_EXTENSION_FACTORIES` ↔ `manifest.staticExtensions`

**Files:**
- Create: `bun-apps/pi-agent/src/static-extensions.test.ts`

- [ ] **Step 1: Write the test** (it should pass immediately — it's a drift guard; both lists currently hold the same 10 names):

```ts
import { describe, expect, test } from "bun:test";
import manifest from "../run-dir/manifest.json";
import { STATIC_EXTENSION_FACTORIES } from "./static-extensions.ts";

/**
 * Drift guard: scripts/deploy.ts copies package dirs from
 * manifest.staticExtensions, while runtime loading uses the static imports in
 * static-extensions.ts. If the two lists drift, a deploy silently ships
 * without a package the runtime needs (or copies dead weight). Names must
 * match 1:1.
 */
describe("static extensions ↔ manifest.staticExtensions", () => {
	test("factory names equal manifest.staticExtensions exactly", () => {
		const factoryNames = [...STATIC_EXTENSION_FACTORIES.map((f) => f.name)].sort();
		const manifestNames = [...(manifest.staticExtensions ?? [])].sort();
		expect(factoryNames).toEqual(manifestNames);
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/static-extensions.test.ts )`
Expected: PASS (both lists are the same 10 names today). If it FAILS, the lists have already drifted — fix `manifest.json`/`static-extensions.ts` to agree before proceeding, and note it in the commit message.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent/src/static-extensions.test.ts
git commit -m "test(pi-agent): guard static-extensions.ts against manifest.staticExtensions drift"
```

---

### Task 6: Patch file naming consistency

**Files:**
- Rename: `bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts` → `bun-apps/pi-agent/src/patches/pre-load-providers.ts`
- Modify: `bun-apps/pi-agent/src/patches/index.ts:156`
- Modify: `bun-apps/pi-agent/src/pre-load-providers.ts:20,94` (comment references)

Rationale: every other file in `patches/` is named for what it patches with no suffix (`skip-update-check.ts`, `set-package-dir.ts`, …); this is the lone `-patch` outlier. The directory path (`patches/`) already disambiguates it from the pure-data sibling `src/pre-load-providers.ts`. `docs/HISTORY.md` mentions the old name in a dated changelog entry — leave that as historical record.

- [ ] **Step 1: Rename and update references**

```bash
git mv bun-apps/pi-agent/src/patches/pre-load-providers-patch.ts bun-apps/pi-agent/src/patches/pre-load-providers.ts
```

In `src/patches/index.ts` line 156 change:

```ts
        await import("./pre-load-providers-patch.ts");
```

to:

```ts
        await import("./pre-load-providers.ts");
```

In the renamed `src/patches/pre-load-providers.ts` line 2, update the header comment's own name (`pre-load-providers-patch —` → `patches/pre-load-providers —`). In `src/pre-load-providers.ts` update both comment references (lines 20 and 94): `./patches/pre-load-providers-patch.ts` → `./patches/pre-load-providers.ts`.

- [ ] **Step 2: Verify nothing else references the old name**

```bash
grep -rn "pre-load-providers-patch" bun-apps --include='*.ts' --include='*.json' -l | grep -v node_modules
```

Expected: no output (docs/HISTORY.md is markdown and intentionally excluded).

- [ ] **Step 3: Run the suite**

Run: `( cd bun-apps/pi-agent && bun test )`
Expected: PASS — `src/patches/index.test.ts` exercises `applyPatches` and would catch a broken import.

- [ ] **Step 4: Commit**

```bash
git add -A bun-apps/pi-agent/src
git commit -m "refactor(pi-agent): drop -patch suffix from pre-load-providers patch file"
```

---

### Task 7: Documentation — truthful `-ne`/`-ns` semantics + stale counts

**Files:**
- Modify: `bun-apps/pi-agent/README.md` (lines ~185-199, ~375-385, plus every stale "5 static" count)
- Modify: `bun-apps/pi-agent/docs/deploy-single-binary.md` (same stale counts, if present)

- [ ] **Step 1: Find every stale claim**

```bash
grep -n -i "5 static\|five static\|these 5\|zero extensions" bun-apps/pi-agent/README.md bun-apps/pi-agent/docs/*.md
```

- [ ] **Step 2: Fix counts and rewrite the `-ne` claims.** Replace each "5"-count with 10 (the Group A + Group B set in `static-extensions.ts`). In the README section that currently reads:

> Everything else in `manifest.json` (movie-director, flux2, obsidian, …) — roughly a dozen extensions — is **not available in the compiled binary**. Use source or bundle mode for those, or run the binary with `-ne` if you want zero extensions.

replace with:

```markdown
Everything else in `manifest.json` (movie-director, flux2, research-tool, …)
is **not available in the compiled binary**. Use source or bundle mode for
those, or run the binary with `-ne` for a clean start with zero injected
extensions (see "Flag semantics" below).
```

(also drop `obsidian` from that example list — it is a static extension now). Apply the same rewrite to the second `-ne` claim near line 381.

- [ ] **Step 3: Add a "Flag semantics: -ne / -ns" subsection** to README.md (place it next to the existing extension-loading/build-modes docs):

```markdown
### Flag semantics: `-ne` / `-ns`

User-passed `-ne`/`--no-extensions` and `-ns`/`--no-skills` are honored by the
wrapper (since 2026-07-19):

- `-ne` — suppresses BOTH injection channels: the run-dir `-e` splice
  (`src/patches/load-run-dir-resources.ts`) and the static factories
  (`src/cli.ts` passes `[]` to `main()`). Your own explicit `-e <path>` still
  loads — same as upstream pi, where `-ne` + explicit `-e` means "only this
  extension".
- `-ns` — suppresses the run-dir `--skill` splice. Your own `--skill <path>`
  still loads.
- Deploy layouts still self-inject `-ne` internally (run-dir/resolve.ts) so a
  deployed pi-agent ignores whatever `.pi/` exists in your cwd. That injected
  flag is invisible to the user-flag detection, which reads argv BEFORE the
  splice happens.

Detection lives in `src/cli-argv.ts` (`userSuppressFlags`); filtering lives in
`run-dir/resolve.ts` (`suppressResolvedArgv`).
```

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/README.md bun-apps/pi-agent/docs
git commit -m "docs(pi-agent): document -ne/-ns semantics, fix stale static-extension counts"
```

---

### Task 8: pi-agent-cli — derive `discoverExtensionEntries()` from pi-agent's manifest

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts:140-163`
- Test: `bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts`
- Modify: `bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json`
- Modify: `CLAUDE.md` (obsolete canary caveat)

Background: the current hard-coded 11-entry list has already drifted — `research-tool`, `zai-mcp`, `hermes-memory`, `obsidian`, and `workflow` all register tools but are missing, so `schema-cost` / boot-smoke undercount context cost. Deriving from `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]` + `staticExtensions[]` via the `pi-agent-ext-<X>/extensions/<X>.ts` naming convention unified in #675) makes future extension changes zero-CLI-edit.

- [ ] **Step 1: Write the failing test** — append to `src/__tests__/schema-cost.test.ts`:

```ts
describe("discoverExtensionEntries (manifest-derived)", () => {
	// repo root = ../../../.. from this test file
	const root = resolveRepoRoot(join(import.meta.dir, "..", ".."));

	test("covers every manifest extension and every static extension", () => {
		const sources = new Set(discoverExtensionEntries(root).map((e) => e.source));
		// dynamic manifest.extensions
		for (const s of ["power-tool", "tool-gate", "flux2", "krea2", "ltx", "research-tool", "zai-mcp", "movie-director"]) {
			expect(sources.has(s)).toBe(true);
		}
		// staticExtensions via the extensions/<X>.ts convention
		for (const s of ["goal-todo", "hermes-memory", "superpowers", "wayfind", "web-access", "obsidian", "btw", "file2md", "workflow", "knowledge-card"]) {
			expect(sources.has(s)).toBe(true);
		}
		// curated extra kept
		expect(sources.has("movie-director-cost")).toBe(true);
	});

	test("every derived path exists on disk and is absolute", () => {
		for (const e of discoverExtensionEntries(root)) {
			expect(isAbsolute(e.path)).toBe(true);
			expect(existsSync(e.path)).toBe(true);
		}
	});
});
```

(Add any missing imports at the top of the test file: `discoverExtensionEntries`, `resolveRepoRoot` from `../commands/schema-cost.ts`; `existsSync` from `node:fs`; `isAbsolute`, `join` from `node:path`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-cli && bun test src/__tests__/schema-cost.test.ts )`
Expected: FAIL — `tool-gate`, `research-tool`, `zai-mcp`, `hermes-memory`, `superpowers`, `wayfind`, `obsidian`, `workflow` missing from the hard-coded list.

- [ ] **Step 3: Implement** — replace `discoverExtensionEntries` in `src/commands/schema-cost.ts:140-163` with:

```ts
/**
 * Entries kept OUTSIDE the manifest derivation: measurable extension files
 * that are not registered anywhere in pi-agent (neither manifest.extensions
 * nor staticExtensions) but are still worth costing.
 */
const EXTRA_ENTRIES: { source: string; path: string }[] = [
	{ source: "movie-director-cost", path: "bun-apps/pi-agent-ext-movie-director/extensions/movie-director-cost.ts" },
];

/**
 * Discover extension entry files by DERIVING them from pi-agent's
 * run-dir/manifest.json — the single source of truth for what a pi-agent
 * session loads:
 *   - `extensions[]`      → `bun-apps/<entry>` (dynamic `-e` set)
 *   - `staticExtensions[]`→ `bun-apps/<pkg>/extensions/<suffix>.ts` where
 *     suffix = pkg minus the `pi-agent-ext-` prefix (the repo-wide canonical
 *     entry convention, enforced since #675)
 * plus EXTRA_ENTRIES above. Adding/removing an extension in pi-agent needs
 * ZERO edits here. Falls back to EXTRA_ENTRIES only when the manifest is
 * unreadable (e.g. a compiled CLI running outside the repo).
 */
export function discoverExtensionEntries(cwd: string): { source: string; path: string }[] {
	let manifest: { extensions?: (string | { entry: string })[]; staticExtensions?: string[] } = {};
	try {
		manifest = JSON.parse(
			readFileSync(resolve(cwd, "bun-apps/pi-agent/run-dir/manifest.json"), "utf8"),
		);
	} catch {
		// outside the repo — measure extras only
	}
	const entries: { source: string; path: string }[] = [];
	for (const e of manifest.extensions ?? []) {
		const rel = typeof e === "string" ? e : e.entry;
		const pkg = rel.split("/")[0] ?? "";
		entries.push({ source: pkg.replace(/^pi-agent-ext-/, ""), path: `bun-apps/${rel}` });
	}
	for (const pkg of manifest.staticExtensions ?? []) {
		const suffix = pkg.replace(/^pi-agent-ext-/, "");
		entries.push({ source: suffix, path: `bun-apps/${pkg}/extensions/${suffix}.ts` });
	}
	entries.push(...EXTRA_ENTRIES);
	const out: { source: string; path: string }[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		const abs = isAbsolute(e.path) ? e.path : resolve(cwd, e.path);
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push({ source: e.source, path: abs });
	}
	return out;
}
```

(`readFileSync` needs importing from `node:fs` at the top of schema-cost.ts if not already there; `isAbsolute`/`resolve` are already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-cli && bun test src/__tests__/schema-cost.test.ts )`
Expected: PASS.

- [ ] **Step 5: Re-baseline boot-smoke.** Run the canary and inspect its real output:

Run: `( cd bun-apps/pi-agent-cli && bun test src/__tests__/boot-smoke.test.ts )`

The wider coverage will raise the measured tool count and add new sources. Update `src/__tests__/__fixtures__/boot-smoke.baseline.json`:
- `sourceMinimum`: add `"tool-gate"`, `"research-tool"`, `"zai-mcp"`, `"hermes-memory"`, `"superpowers"`, `"wayfind"`, `"obsidian"`, `"workflow"`, `"btw"`, `"movie-director-cost"` (keep the existing 9; drop any the canary reports as zero-tool if the test requires tool-registering sources — read the test's assertion to decide).
- `toolCountFloor`: set to the observed total minus a small safety margin (match how the current floor of 29 relates to the old observed count — inspect the test comments/output).
- `expectedErrorSources`: if any newly-covered extension fails to load in the canary (e.g. an env-gated MCP extension), add its source here instead of forcing a pass.

Re-run until green: `( cd bun-apps/pi-agent-cli && bun test src/__tests__/boot-smoke.test.ts )`
Expected: PASS with the updated baseline.

- [ ] **Step 6: Update CLAUDE.md.** Replace the now-obsolete caveat under "Extension packages":

> - **Schema-cost canary**: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` `discoverExtensionEntries()` is an explicit curated list — when adding a tool-registering domain extension, add it there too or boot-smoke won't measure it.

with:

```markdown
- **Schema-cost canary**: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` `discoverExtensionEntries()` derives its list from `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]` + `staticExtensions[]`) — extensions registered there are measured automatically. Only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
```

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-cli/src/commands/schema-cost.ts bun-apps/pi-agent-cli/src/__tests__/schema-cost.test.ts bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json CLAUDE.md
git commit -m "feat(pi-agent-cli): derive schema-cost extension list from pi-agent manifest"
```

---

### Task 9: pi-agent-cli — de-duplicate the command tables

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/commands/sessions.ts:151` (add `name: "sessions",`)
- Modify: `bun-apps/pi-agent-cli/src/commands/memory.ts:111` (add `name: "memory",`)
- Modify: `bun-apps/pi-agent-cli/src/cli.ts:66-201`

- [ ] **Step 1: Add the missing `name` fields.** In `sessions.ts` the exported object at line 151 gains `name: "sessions",` as its first property; in `memory.ts` line 111 gains `name: "memory",`. Verify every other referenced command already carries `name`:

```bash
grep -L 'name:' bun-apps/pi-agent-cli/src/commands/{chat,agent,file2md,zk-extract,zk-card,zk-ask,zk-ingest,zk-query,kcard-loop,doctor,tools-metrics,sessions,memory,pdf-to-vault,image-to-vault,url-to-vault,knowledge-pipeline,memory-to-vault,workflow}.ts
```

Expected: no output after the two edits.

- [ ] **Step 2: Collapse the tables.** In `cli.ts`, replace the three wrapper-object arrays with direct references (order preserved — it drives help display):

```ts
const COMMANDS: Command[] = [
	chatCommand,
	agentCommand,
	file2mdCommand,
	zkExtractCommand,
	zkCardCommand,
	zkAskCommand,
	zkIngestCommand,
	zkQueryCommand,
	kcardLoopCommand,
	doctorCommand,
	toolsMetricsCommand,
	sessionsCommand,
	memoryCommand,
	// Extension-backed sub-commands (each = one workspace extension exporting an
	// ExtensionSubcommandSpec). See src/extensions/registry.ts.
	...EXTENSION_COMMANDS,
];

const PIPELINES: Command[] = [
	pdfToVaultCommand,
	imageToVaultCommand,
	urlToVaultCommand,
	youtubeToVaultCommand,
	memoryToVaultCommand,
];

const WORKFLOWS: Command[] = [workflowRunCommand, workflowListCommand];
```

If TypeScript reports a command object's `run` signature as incompatible with `Command["run"]`, fix the COMMAND MODULE's typing (annotate the exported object `satisfies Command` or align its `run` parameter type with `ParsedArgs`) — do NOT widen the `Command` interface.

- [ ] **Step 3: Run the pi-agent-cli suite**

Run: `( cd bun-apps/pi-agent-cli && bun test )`
Expected: PASS — `args.test.ts` / `dispatch.test.ts` exercise command routing and RESERVED-token behavior, which is derived from these arrays and must be unchanged. Spot-check help output:

```bash
( cd bun-apps/pi-agent-cli && bun src/cli.ts help | head -30 )
```

Expected: same command list and order as before the change.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-cli/src/cli.ts bun-apps/pi-agent-cli/src/commands/sessions.ts bun-apps/pi-agent-cli/src/commands/memory.ts
git commit -m "refactor(pi-agent-cli): reference command objects directly in COMMANDS tables"
```

---

### Task 10: Full verification + wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Full test suites, both packages**

```bash
( cd bun-apps/pi-agent && bun test )
( cd bun-apps/pi-agent-cli && bun test )
```

Expected: both PASS.

- [ ] **Step 2: Behavior matrix spot-check** (source mode; each command exits after printing):

```bash
( cd bun-apps/pi-agent && BUN_PI_DEBUG_RUN_DIR=1 bun src/cli.ts -ne --list-models 2>&1 | grep "resolved argv" )   # no -e, has --skill
( cd bun-apps/pi-agent && BUN_PI_DEBUG_RUN_DIR=1 bun src/cli.ts -ns --list-models 2>&1 | grep "resolved argv" )   # has -e, no --skill
( cd bun-apps/pi-agent && BUN_PI_DEBUG_RUN_DIR=1 bun src/cli.ts --list-models 2>&1 | grep "resolved argv" )       # full set
```

- [ ] **Step 3: Deploy-mode regression** (the injected `-ne` must still work with the new filter in place):

```bash
( cd bun-apps/pi-agent && bun scripts/deploy.ts && PIAGENT_DEBUG=1 BUN_PI_DEBUG_RUN_DIR=1 dist/pi-agent-deploy/run.sh --list-models 2>&1 | head -20 )
```

Expected: deploy-bundle mode banner; resolved argv starts with `-ne` followed by `-e <…>/ext-bundles/…` pairs. (Adjust the deploy output dir to whatever `scripts/deploy.ts` prints if it differs.)

- [ ] **Step 4: Push and open the PR** (repo SOP: squash-merge convention; merge + branch-delete are separate user confirmations)

```bash
git push -u origin feat/ne-ns-user-flags
gh pr create --title "feat(pi-agent): honor user -ne/-ns; manifest-derived schema-cost; customization cleanup" --body "$(cat <<'EOF'
## Summary
- User-passed `-ne`/`--no-extensions` and `-ns`/`--no-skills` now actually suppress pi-agent's injected extensions/skills (previously defeated by the run-dir argv splice + ungated static factories; verified against vendored resource-loader).
- Deploy layouts' self-injected `-ne` (self-containment) is unaffected — user flags are read from the pre-splice argv.
- pi-agent-cli `schema-cost` now derives its extension list from pi-agent's run-dir/manifest.json (the hard-coded list had drifted: research-tool/zai-mcp/hermes-memory/obsidian/workflow were unmeasured); boot-smoke re-baselined.
- Drift guard test: STATIC_EXTENSION_FACTORIES ↔ manifest.staticExtensions.
- Naming: patches/pre-load-providers-patch.ts → patches/pre-load-providers.ts (lone `-patch` suffix outlier).
- cli.ts command tables reference command objects directly (~100 lines of boilerplate removed).
- README: stale "5 static extensions" counts fixed; new "Flag semantics: -ne/-ns" section.

## Test plan
- [ ] `( cd bun-apps/pi-agent && bun test )`
- [ ] `( cd bun-apps/pi-agent-cli && bun test )`
- [ ] `-ne`/`-ns`/default matrix via BUN_PI_DEBUG_RUN_DIR=1 (Task 10 Step 2)
- [ ] deploy-bundle smoke (Task 10 Step 3)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** user asks were (a) `-ne`/`-ns` must work under the customization → Tasks 1-4 + docs Task 7; (b) optimize customize code → Tasks 5 (drift guard), 8 (manifest derivation, zero-CLI-edit extension changes), 9 (table dedup); (c) file naming → Task 6 (the one naming outlier; entry naming was already unified repo-wide by #675, nothing else to rename).
- **Deliberately out of scope (YAGNI):** per-extension flag declarations in `ExtensionSubcommandSpec` (extension subcommands still parse via the shared flag-spec tables — a design tradeoff, not a defect); gating `--skill` emission on `-ns` in compiled-binary mode is covered automatically because the filter wraps ALL modes' returns.
- **Type consistency check:** `userSuppressFlags` returns `{noExtensions, noSkills}` (booleans) — consumed with the same names in Tasks 3-4; `suppressResolvedArgv(argv, {noExtensions?, noSkills?})` optional-field object matches `resolveRunDirArgv`'s param type; `discoverExtensionEntries` keeps its existing `(cwd: string) → {source, path}[]` signature so `collectExtensionToolCosts` callers are untouched.
- **Known measurement risk (Task 8 Step 5):** newly-covered extensions may fail to load inside the canary (env-gated deps, e.g. zai-mcp). The baseline's `expectedErrorSources` field exists exactly for this — record, don't force.
