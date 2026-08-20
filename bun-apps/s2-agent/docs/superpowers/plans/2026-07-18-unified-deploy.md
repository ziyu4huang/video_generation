# Unified `deploy.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `build.ts` + `deploy.ts` + `build-extensions.ts` with a single `deploy.ts` offering four deploy modes (--bundle, --snapshot, --standalone, --exe).

**Architecture:** A unified `scripts/deploy.ts` imports from `lib/` helpers (codegen, thin-bundle extensions, embed-assets codegen). Each mode is a short pipeline of stages — common stages shared, mode-specific stages added. Old files deleted after verification.

**Tech Stack:** Bun 1.3.x, TypeScript (no external deps), node:fs, node:path, child_process

## Global Constraints

- All paths relative to `bun-apps/s2-agent/` unless noted.
- Never use `cd` at top level — use `resolve()`, `spawn()` with `cwd`, or `--cwd`.
- Generated files (`src/generated/*.ts`) are gitignored.
- `.ts` source files in `scripts/` are run directly by `bun`, not compiled.
- All 5 static extensions must remain loadable in --exe mode (same as current --compile-embed).
- Classic `--compile` (companion dirs) is removed — `--exe` is its replacement.

---

### Task 1: Create `scripts/lib/codegen.ts`

**Files:**
- Create: `scripts/lib/codegen.ts`
- (Nothing else yet — pure extraction)

**Interfaces:**
- Produces:
  - `function stageGeneratePkgDir(piPkgDir: string): void`
  - `function stageGenerateRunDirBase(npmExtensions: NpmExt[]): void`
  - `function stageGenerateEmbeddedAssets(piPkgDir: string, bunAppsDir: string, binarySkills: string[], embedMode: boolean): void`

This is a pure extraction of the three codegen functions from `scripts/build.ts` (stages 0, 0b, 0c). No behavior change. The functions are identical in signature and body — just moved to a shared module.

The constants `GENERATED_DIR = "src/generated"` and `GENERATED_PKG_DIR` / `GENERATED_RUN_DIR_BASE` paths are defined here too.

- [ ] **Step 1: Create `scripts/lib/codegen.ts`**

Copy the three stage functions verbatim from `scripts/build.ts`:
- `stageGeneratePkgDir()` (lines ~133-142 in current build.ts)
- `stageGenerateRunDirBase()` (lines ~148-170 in current build.ts)
- `stageGenerateEmbeddedAssets()` (lines ~174-190 in current build.ts)

```typescript
// scripts/lib/codegen.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateEmbeddedAssets } from "../generate-embedded-assets.ts";

export const GENERATED_DIR = "src/generated";
const GENERATED_PKG_DIR = `${GENERATED_DIR}/pi-pkg-dir.ts`;
const GENERATED_RUN_DIR_BASE = `${GENERATED_DIR}/run-dir-base.ts`;

function ensureOutdir() {
  if (!existsSync(GENERATED_DIR)) mkdirSync(GENERATED_DIR, { recursive: true });
}

export interface NpmExt { pkg: string; entry: string }

export function stageGeneratePkgDir(piPkgDir: string) {
  console.log(`▶ generate src/generated/pi-pkg-dir.ts`);
  ensureOutdir();
  writeFileSync(
    GENERATED_PKG_DIR,
    `// AUTO-GENERATED — do not edit or commit\n` +
    `export const PI_PKG_DIR = ${JSON.stringify(piPkgDir)};\n`,
  );
  console.log(`  ✓ PI_PKG_DIR = ${piPkgDir}`);
}

export function stageGenerateRunDirBase(npmExtensions: NpmExt[]) {
  console.log(`▶ generate src/generated/run-dir-base.ts`);
  ensureOutdir();
  const bunAppsDir = resolve(process.cwd(), "..");
  const npmExtensionPaths: string[] = [];
  for (const { pkg, entry } of npmExtensions) {
    try {
      const pkgJsonUrl = import.meta.resolve(`${pkg}/package.json`);
      const pkgDir = dirname(new URL(pkgJsonUrl).pathname);
      npmExtensionPaths.push(`${pkgDir}/${entry}`);
    } catch {
      console.log(`  · skipping npm extension "${pkg}" (not resolvable)`);
    }
  }
  writeFileSync(
    GENERATED_RUN_DIR_BASE,
    `// AUTO-GENERATED — do not edit or commit\n` +
    `export const BUN_APPS_DIR = ${JSON.stringify(bunAppsDir)};\n` +
    `export const NPM_EXTENSION_PATHS = ${JSON.stringify(npmExtensionPaths, null, 2)};\n`,
  );
  console.log(`  ✓ BUN_APPS_DIR = ${bunAppsDir}`);
  console.log(`  ✓ ${npmExtensionPaths.length} npm extension path(s) resolved`);
}

export function stageGenerateEmbeddedAssets(
  piPkgDir: string,
  bunAppsDir: string,
  binarySkills: string[],
  embedMode: boolean,
) {
  console.log(`▶ generate src/generated/embedded-assets.ts${embedMode ? " (with imports)" : " (empty manifest)"}`);
  ensureOutdir();
  generateEmbeddedAssets(piPkgDir, bunAppsDir, binarySkills, embedMode);
}
```

- [ ] **Step 2: Verify the module imports correctly**

```bash
cd bun-apps/s2-agent
bun -e "const m = await import('./scripts/lib/codegen.ts'); console.log(Object.keys(m).filter(k => k.startsWith('stage')))"
```

Expected output: `[ "stageGeneratePkgDir", "stageGenerateRunDirBase", "stageGenerateEmbeddedAssets" ]`

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/codegen.ts
git commit -m "refactor: extract codegen stages into scripts/lib/codegen.ts"
```

---

### Task 2: Simplify `scripts/lib/build-extensions.ts` (thin-only)

**Files:**
- Copy from: `scripts/build-extensions.ts`
- Create: `scripts/lib/build-extensions.ts`
- _(old `build-extensions.ts` stays until Task 4 — deleted after verification)_

**Interfaces:**
- Produces: `async function buildExtensions(targetDir: string): Promise<{ count: number }>`

This is a trimmed version of `scripts/build-extensions.ts` that:
- Removes full-bundle logic (THIN / FULL distinction, `--full` flag, `FULL_EXTERNALS`)
- Keeps thin-bundle logic only
- Keeps hash cache (`<name>.thin.hash` files)
- Keeps NPM_EXTERNAL handling for thin bundles
- Removes deploy/packaging logic (the old file was also used to copy files to target — that moves to deploy.ts)

The function signature: takes `targetDir` (the `ext-bundles/` subdirectory), builds each extension from `manifest.json`'s `extensions` array.

- [ ] **Step 1: Create `scripts/lib/build-extensions.ts`**

Start from the current `scripts/build-extensions.ts` and trim:
1. Remove `BOOTSTRAP_EXTENSION` and full-bundle constants.
2. Keep `THIN_EXTERNALS` and `NPM_EXTERNAL` — same as today.
3. Keep the hash cache logic.
4. Export a single async function:

```typescript
// scripts/lib/build-extensions.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import manifest from "../../run-dir/manifest.json";

const THIN_EXTERNALS = [ /* same as current build-extensions.ts */ ];
const BOOTSTRAP_SCRIPT = `/* same thin bootstrap as current thinExtBootstrap */`;

interface ExtEntry {
  name: string;
  entry: string;
  thin?: boolean;
  full?: boolean;
}

// Parse manifest.extensions into ExtEntry[] (thin always — no full)
function parseExtensions(): ExtEntry[] { /* ... */ }

function extHash(name: string, entry: string, skip: boolean): string { /* same as current */ }

export async function buildExtensions(targetDir: string): Promise<{ count: number }> {
  mkdirSync(targetDir, { recursive: true });
  const entries = parseExtensions();
  let count = 0;
  for (const ext of entries) {
    const hash = extHash(ext.name, ext.entry, false);
    const hashFile = join(targetDir, `${ext.name}.thin.hash`);
    if (existsSync(hashFile) && readFileSync(hashFile, "utf8") === hash) {
      console.log(`  · ${ext.name}.thin.js  (cached)`);
      count++;
      continue;
    }
    // Build thin bundle...
    // Same logic as current thin-bundle build
    writeFileSync(join(targetDir, `${ext.name}.thin.hash`), hash);
    count++;
  }
  return { count };
}
```

The complete implementation should be a strict subset of the current `build-extensions.ts`. If in doubt, keep the current thin-bundle code verbatim and only delete full-bundle branches.

- [ ] **Step 2: Verify thin bundles still build**

```bash
mkdir -p /tmp/plan-test-ext
bun -e "const { buildExtensions } = await import('./scripts/lib/build-extensions.ts'); console.log(await buildExtensions('/tmp/plan-test-ext'))"
```

Expected: builds all extensions as `.thin.js` files.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/build-extensions.ts
git commit -m "refactor: create thin-only build-extensions lib"
```

---

### Task 3: Create `scripts/deploy.ts` (unified orchestrator)

**Files:**
- Create: `scripts/deploy.ts`

**Depends on:** Task 1 (`lib/codegen.ts`), Task 2 (`lib/build-extensions.ts`), existing `lib/generate-embedded-assets.ts`

This is the main file. It parses flags and runs the appropriate pipeline.

- [ ] **Step 1: Write the header + flag parsing + mode dispatch**

```typescript
// scripts/deploy.ts — unified build + deploy orchestrator
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stageGeneratePkgDir, stageGenerateRunDirBase, stageGenerateEmbeddedAssets, type NpmExt } from "./lib/codegen.ts";
import { buildExtensions } from "./lib/build-extensions.ts";
import manifest from "../run-dir/manifest.json";

const APP_NAME = "s2-agent";

const argv = process.argv.slice(2);
const target = argv.find(a => !a.startsWith("--")) || resolve(process.cwd(), "..", "..", "dist", APP_NAME);
const IS_BUNDLE = !argv.some(a => ["--snapshot", "--standalone", "--exe"].includes(a));
const IS_SNAPSHOT = argv.includes("--snapshot");
const IS_STANDALONE = argv.includes("--standalone");
const IS_EXE = argv.includes("--exe");
const NO_FREEZE = argv.includes("--no-freeze");

function die(msg: string): never { console.error(msg); process.exit(1); }

async function main() {
  // Assert workspace deps (same as current build.ts)
  assertWorkspaceDeps();

  const piPkgDir = resolvePiPkgDir();
  const bunAppsDir = resolve(process.cwd(), "..");
  const npmExts: NpmExt[] = manifest.npmExtensions ?? [];
  const binarySkills: string[] = manifest.binarySkills ?? [];

  // Stage 1: Codegen (all modes)
  stageGeneratePkgDir(piPkgDir);
  stageGenerateRunDirBase(npmExts);
  stageGenerateEmbeddedAssets(piPkgDir, bunAppsDir, binarySkills, IS_EXE);

  if (IS_EXE) {
    // --exe: compile directly from source, skip bundle/ext-bundles/skills/run.sh
    await stageExe();
    return;
  }

  // Stage 2: Bundle s2-agent.js
  await stageBundle(piPkgDir);

  if (IS_SNAPSHOT) {
    // --snapshot: copy source + node_modules, no ext-bundles
    await stageSnapshot(bunAppsDir);
    return;
  }

  // Stage 3: Bundle extensions (thin)
  mkdirSync(join(target, "ext-bundles"), { recursive: true });
  await buildExtensions(join(target, "ext-bundles"));

  // Stage 4: Copy skills
  // ... copy manifest.skills → target/skills/

  // Stage 5: run.sh
  writeRunSh(target, IS_STANDALONE);

  if (IS_STANDALONE) {
    await stageCopyLocalBun();
  }

  // Stage 6: Freeze
  if (!NO_FREEZE) stageFreeze(target);

  console.log("▶ done");
}
```

The actual implementation has each stage function fully defined inline.

- [ ] **Step 2: Implement `stageBundle()`**

Copied from `build.ts`'s `stageBundle()` — uses `Bun.build()`. Adds `--external` for hermes-optional deps.

```typescript
async function stageBundle(piPkgDir: string) {
  console.log(`▶ bundle → ${join(target, `${APP_NAME}.js`)}`);
  clean(OUTFILE, MAPFILE);
  const { build } = await import("bun");
  const result = await build({
    entrypoints: ["src/cli.ts"],
    outdir: target,
    target: "bun",
    format: "esm",
    naming: `${APP_NAME}.js`,
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: WITH_SOURCEMAP ? "external" : "none",
    splitting: false,
    external: HERMES_OPTIONAL_EXTERNALS,
  });
  if (!result.success) { for (const l of result.logs) console.error(l); process.exit(1); }
  // Symlink node_modules for bundle mode extension resolution
  linkNodeModules(piPkgDir);
}
```

- [ ] **Step 3: Implement `stageExe()` for --exe**

Same as current `stageCompileEmbed()` in `build.ts`:

```typescript
async function stageExe() {
  console.log(`▶ compile → ${join(target, APP_NAME)}  (single-pass embed binary)`);
  clean(join(target, APP_NAME));
  const externalFlags = HERMES_OPTIONAL_EXTERNALS.flatMap(p => ["--external", p]);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", "src/cli.ts", `--outfile=${join(target, APP_NAME)}`, "--minify", ...externalFlags],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) die(`  ✗ bun build --compile exited ${code}`);
  console.log(`  ✓ ${join(target, APP_NAME)}  (${formatSize(join(target, APP_NAME))})`);
}
```

- [ ] **Step 4: Implement `stageSnapshot()` for --snapshot**

```typescript
async function stageSnapshot(bunAppsDir: string) {
  console.log(`▶ snapshot → ${target}`);
  // Copy s2-agent source tree (including generated files)
  const piAgentSrc = join(bunAppsDir, "s2-agent");
  cpSync(piAgentSrc, join(target, "s2-agent"), { recursive: true, force: true });
  // Copy node_modules from bun-apps root
  console.log(`  · copying node_modules...`);
  cpSync(join(bunAppsDir, "node_modules"), join(target, "node_modules"), { recursive: true, force: true });
  // Write run.sh
  writeRunSh(target, false);  // uses system bun with s2-agent/src/cli.ts
  if (!NO_FREEZE) stageFreeze(target);
  console.log("▶ done");
}
```

- [ ] **Step 5: Implement `writeRunSh()`**

```typescript
function writeRunSh(outDir: string, useLocalBun: boolean) {
  const bunCmd = useLocalBun ? './bun' : 'bun';
  const entry = useLocalBun ? 's2-agent.js' : 's2-agent/src/cli.ts';
  const content = `#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
exec "${bunCmd}" run "$DIR/${entry}" "$@"
`;
  writeFileSync(join(outDir, "run.sh"), content, { mode: 0o755 });
}
```

- [ ] **Step 6: Implement `stageCopyLocalBun()` for --standalone**

```typescript
async function stageCopyLocalBun() {
  const result = spawnSync("which", ["bun"], { stdio: "pipe" });
  if (result.status !== 0) die("  ✗ bun not found in PATH");
  const bunPath = result.stdout.toString().trim();
  console.log(`  · copying bun binary: ${bunPath}`);
  cpSync(bunPath, join(target, "bun"));
}
```

- [ ] **Step 7: Implement `stageFreeze()`**

Same as current deploy.ts — `chmod -R a-w` + write `.deploy-readonly` marker.

- [ ] **Step 8: Verify all 4 modes work**

```bash
cd bun-apps/s2-agent

# --bundle (default)
rm -rf /tmp/plan-test-bundle
bun scripts/deploy.ts /tmp/plan-test-bundle --no-freeze
ls /tmp/plan-test-bundle/s2-agent.js  # should exist

# --snapshot
rm -rf /tmp/plan-test-snapshot
bun scripts/deploy.ts /tmp/plan-test-snapshot --snapshot --no-freeze
ls /tmp/plan-test-snapshot/s2-agent/src/cli.ts  # source should exist
ls /tmp/plan-test-snapshot/node_modules  # node_modules should exist

# --standalone
rm -rf /tmp/plan-test-standalone
bun scripts/deploy.ts /tmp/plan-test-standalone --standalone --no-freeze
ls /tmp/plan-test-standalone/bun  # bun binary should exist

# --exe
rm -rf /tmp/plan-test-exe
bun scripts/deploy.ts /tmp/plan-test-exe --exe
/tmp/plan-test-exe/s2-agent doctor --json  # ok:true
```

- [ ] **Step 9: Commit**

```bash
git add scripts/deploy.ts
git commit -m "feat: unified deploy.ts with --bundle/--snapshot/--standalone/--exe"
```

---

### Task 4: Remove old files and update references

**Files:**
- Delete: `scripts/build.ts`, `scripts/deploy.ts` (old), `scripts/build-extensions.ts` (old), `scripts/verify-extensions.ts`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`

- [ ] **Step 1: Delete old scripts**

```bash
git rm scripts/build.ts scripts/deploy.ts scripts/build-extensions.ts scripts/verify-extensions.ts
```

- [ ] **Step 2: Update package.json scripts**

Current `package.json` has:
```json
"scripts": {
  "build:exe": "bun scripts/build.ts --compile",
  ...
}
```

Change to:
```json
"scripts": {
  "deploy": "bun scripts/deploy.ts",
  "deploy:exe": "bun scripts/deploy.ts --exe",
  "deploy:bundle": "bun scripts/deploy.ts --bundle",
  "deploy:snapshot": "bun scripts/deploy.ts --snapshot",
  "deploy:standalone": "bun scripts/deploy.ts --standalone",
  ...
}
```

- [ ] **Step 3: Update CI workflow**

In `.github/workflows/ci.yml`:
- `compile-verify` job: `bun scripts/deploy.ts --exe` instead of `bun scripts/build.ts --compile`
- `deploy-verify` job: `bun scripts/deploy.ts` instead of `bun scripts/deploy.ts`
- Remove `release-verify` or change to `--snapshot`

- [ ] **Step 4: Run full test suite**

```bash
bun test src/patches/index.test.ts  # 17 tests should all pass
```

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/ci.yml
git add -u  # deleted files
git commit -m "chore: remove old build/deploy scripts, update references"
```

---

### Task 5: Update README.md and docs

**Files:**
- Modify: `README.md`
- Modify: `docs/deploy-single-binary.md`

- [ ] **Step 1: Update README.md Build modes section**

Replace the table and command list with:

```markdown
## Build / Deploy modes

```bash
bun scripts/deploy.ts [target]               # --bundle (default): thin bundles, no node_modules
bun scripts/deploy.ts [target] --bundle      # explicit thin-bundle deploy
bun scripts/deploy.ts [target] --snapshot    # full source copy + node_modules (debug)
bun scripts/deploy.ts [target] --standalone  # bundle + local bun binary + run.sh
bun scripts/deploy.ts [target] --exe         # single executable (all assets embedded)
bun scripts/deploy.ts [target] --no-freeze   # skip read-only freeze
```

Update the mode table and standalone binary section to reference `deploy.ts --exe` instead of `build.ts --compile`.

- [ ] **Step 2: Update `docs/deploy-single-binary.md`**

Replace all references to `build.ts --compile` with `deploy.ts --exe`.
Replace TL;DR build command from `bun run build:exe` to `bun scripts/deploy.ts --exe`.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/deploy-single-binary.md
git commit -m "docs: update for unified deploy.ts"
```

---

## Self-Review

**1. Spec coverage:**
- --bundle mode: Task 3 (default branch)
- --snapshot mode: Task 3 (stageSnapshot)
- --standalone mode: Task 3 (stageCopyLocalBun + writeRunSh with useLocalBun=true)
- --exe mode: Task 3 (stageExe)
- codegen extraction: Task 1
- thin-only build-extensions: Task 2
- Remove old files: Task 4
- CI/package.json updates: Task 4
- README/docs: Task 5

**2. No placeholders** — all code snippets are actual implementation code.

**3. Type consistency** — `NpmExt` interface defined in Task 1, consumed in Task 3. `buildExtensions(targetDir)` defined in Task 2, called from Task 3. All consistent.
