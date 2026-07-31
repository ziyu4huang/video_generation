# Archify Deploy-Bundle Path Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all three archify tools work under the default `deploy-bundle` mode (today they die with `Cannot find module` because `vendored/` is never staged), and re-enable the schema-cost canary's coverage of archify.

**Architecture:** Two clusters. Cluster A (archify-internal): `lib/run.ts` gains a `resolveVendoredBin()` ladder (env override → walk-up probe → legacy fallback) plus a pre-flight `existsSync` guard; `scripts/lib/build-extensions.ts` gains `stageVendoredAssets()` that copies each extension's `vendored/` tree into `<targetDir>/vendored/` (and exempts it from stale-cleanup); `lib/render.ts` stops blaming IR validity when the bin is missing. Cluster B (canary triplet): repair the `@repo/pi-agent-ext-subagent` symlink, add archify to `boot-smoke.baseline.json`, refresh `schema-cost-baseline.json`.

**Tech Stack:** Bun + TypeScript, typebox, `@earendil-works/pi-coding-agent`, `bun:test`. Node builtins (`node:fs`, `node:path`, `node:url`, `node:child_process`).

## Global Constraints

- **No vendored edits** — `vendored/` is a snapshot; never modified (snapshot policy).
- **Shell discipline** — never top-level `cd`; use `( cd <dir> && ... )`, `--cwd`, or absolute paths.
- **Python/venv** — not relevant to this plan (Bun-only work).
- **Test invocation** — archify tests: `( cd bun-apps/pi-agent-ext-archify && bun test )`; pi-agent script tests: `( cd bun-apps/pi-agent && bun test scripts/lib/build-extensions.test.ts )`.
- **Spawn contract preserved** — `shell:false`, no PATH dependency, both `error`/`close` resolve (never reject). The `runArchify` signature change is additive (new optional trailing param).
- **Commit messages** end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: `lib/run.ts` — vendored-bin resolution ladder + pre-flight guard

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/lib/run.ts`
- Create: `bun-apps/pi-agent-ext-archify/__tests__/vendored-bin-resolution.test.ts`

**Interfaces:**
- Produces: `export function resolveVendoredBin(startDir?: string): string` — env-first, then walk-up probe (≤6 levels), then legacy `PKG_ROOT/vendored/bin/archify.mjs` fallback. `export const VENDORED_BIN = resolveVendoredBin();` (module-load constant, unchanged name). `runArchify(args, cwd, signal?, bin = VENDORED_BIN)` — new optional 4th param so tests can inject a missing path without env-timing gymnastics.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-archify/__tests__/vendored-bin-resolution.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveVendoredBin, runArchify, VENDORED_BIN } from "../lib/run.ts";

const _env = process.env.PI_ARCHIFY_BIN;
afterEach(() => {
  if (_env === undefined) delete process.env.PI_ARCHIFY_BIN;
  else process.env.PI_ARCHIFY_BIN = _env;
});

describe("resolveVendoredBin", () => {
  it("honors PI_ARCHIFY_BIN env override first", () => {
    process.env.PI_ARCHIFY_BIN = "/custom/path/archify.mjs";
    expect(resolveVendoredBin("/anywhere")).toBe("/custom/path/archify.mjs");
  });

  it("finds vendored/bin/archify.mjs at the start dir (depth 0)", () => {
    const root = mkdtempSync(join(tmpdir(), "vbr-start-"));
    mkdirSync(join(root, "vendored", "bin"), { recursive: true });
    writeFileSync(join(root, "vendored", "bin", "archify.mjs"), "// stub");
    try {
      const got = resolveVendoredBin(root);
      expect(got).toBe(join(root, "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks up to find vendored/bin/archify.mjs at an ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "vbr-walk-"));
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    mkdirSync(join(root, "a", "vendored", "bin"), { recursive: true });
    writeFileSync(join(root, "a", "vendored", "bin", "archify.mjs"), "// stub");
    try {
      const got = resolveVendoredBin(join(root, "a", "b", "c"));
      expect(got).toBe(join(root, "a", "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy source-relative path when nothing is found", () => {
    const empty = mkdtempSync(join(tmpdir(), "vbr-empty-"));
    try {
      delete process.env.PI_ARCHIFY_BIN;
      const got = resolveVendoredBin(empty);
      // Fallback is PKG_ROOT/vendored/bin/archify.mjs (fixed, independent of startDir).
      expect(got.endsWith("vendored/bin/archify.mjs")).toBe(true);
      expect(got).not.toBe(join(empty, "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("runArchify pre-flight", () => {
  it("returns a 'vendored bin not found' error when the bin path does not exist", async () => {
    const result = await runArchify(["--version"], tmpdir(), undefined, "/definitely/nonexistent/archify.mjs");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("vendored bin not found");
    expect(result.stderr).toContain("PI_ARCHIFY_BIN");
  });
});

describe("VENDORED_BIN module constant", () => {
  it("is a string ending in vendored/bin/archify.mjs", () => {
    expect(typeof VENDORED_BIN).toBe("string");
    expect(VENDORED_BIN.endsWith("vendored/bin/archify.mjs")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test __tests__/vendored-bin-resolution.test.ts )`
Expected: FAIL — `resolveVendoredBin` is not exported (and `runArchify` has no 4th param / pre-flight).

- [ ] **Step 3: Implement the resolver + pre-flight**

Replace the top of `bun-apps/pi-agent-ext-archify/lib/run.ts` (imports through the `VENDORED_BIN` declaration and the `runArchify` body). The new full file head + functions:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(MODULE_DIR, "..");

/**
 * Resolve the vendored archify CLI across source / snapshot / bundle deploy
 * modes. Ladder: (1) PI_ARCHIFY_BIN env override, (2) walk-up probe for
 * `vendored/bin/archify.mjs` from startDir upward (bounded to 6 levels), (3)
 * legacy source-relative fallback (preserves prior behavior when nothing is
 * found, so the pre-flight guard — not a throw — surfaces the problem).
 */
export function resolveVendoredBin(startDir: string = MODULE_DIR): string {
  const fromEnv = process.env.PI_ARCHIFY_BIN;
  if (fromEnv) return fromEnv;
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "vendored", "bin", "archify.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(PKG_ROOT, "vendored", "bin", "archify.mjs");
}

/** Absolute path to the vendored archify CLI, resolved once at module load. */
export const VENDORED_BIN = resolveVendoredBin();

/** Surfaced when the resolved bin does not exist on disk (deploy omitted vendored/). */
function binMissingMessage(path: string): string {
  return `archify vendored bin not found at ${path}; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).`;
}
```

Then update `runArchify` to add the optional `bin` param and the pre-flight guard:

```ts
export function runArchify(args: string[], cwd: string, signal?: AbortSignal, bin: string = VENDORED_BIN): Promise<ArchifyResult> {
  return new Promise((resolve) => {
    if (!existsSync(bin)) {
      resolve({ stdout: "", stderr: binMissingMessage(bin), status: 1 });
      return;
    }
    // `encoding: "utf8"` collapses @types/node's spawn overloads to `never`;
    // annotate as ChildProcess and decode chunks manually instead.
    const child: ChildProcess = spawn(process.execPath, [bin, ...args], { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array) => { stdout += Buffer.from(chunk).toString("utf8"); });
    child.stderr?.on("data", (chunk: Uint8Array) => { stderr += Buffer.from(chunk).toString("utf8"); });
    // Both `error` (spawn/abort failure) and `close` resolve — we never reject,
    // so callers can treat a non-zero/null status uniformly as failure.
    child.on("error", () => resolve({ stdout, stderr, status: null }));
    child.on("close", (code) => resolve({ stdout, stderr, status: code }));
  });
}
```

Leave `withTempIr` and the `ArchifyResult` interface unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test __tests__/vendored-bin-resolution.test.ts )`
Expected: PASS (all 6 specs).

- [ ] **Step 5: Run the full archify suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test )`
Expected: PASS — all existing tests (delta, e2e, inspect-artifact, load-ir, output-path, real-result, render, run, validate, validators-drift, vendored-bin-recovery) still green. Source mode still resolves the real bin.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/run.ts bun-apps/pi-agent-ext-archify/__tests__/vendored-bin-resolution.test.ts
git commit -m "fix(archify): vendored-bin resolution ladder + pre-flight guard (deploy-bundle path fix)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `lib/render.ts` — stop blaming IR validity when the vendored bin is missing

**Files:**
- Modify: `bun-apps/pi-agent-ext-archify/lib/render.ts:56-60` (the `catch` block of the deliver JSON parse)
- Create: `bun-apps/pi-agent-ext-archify/__tests__/render-bin-missing.test.ts`

**Interfaces:**
- Consumes: Task 1's `runArchify` pre-flight, which (when the bin is missing) resolves `{ stdout: "", stderr: "<...> vendored bin not found <...>", status: 1 }`. The test stubs `run.ts` via `mock.module` to return exactly that shape, so it exercises render's `catch`-block formatting deterministically (the pre-flight behavior itself is unit-tested in Task 1).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-archify/__tests__/render-bin-missing.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";

// Stub run.ts so runArchify returns the exact pre-flight "bin missing" shape
// (stdout empty, stderr carrying the vendored-bin-not-found message). This
// tests render.ts's catch-block formatting in isolation; the real pre-flight
// is covered by vendored-bin-resolution.test.ts.
mock.module("../lib/run.ts", () => ({
  VENDORED_BIN: "/nonexistent/archify.mjs",
  resolveVendoredBin: () => "/nonexistent/archify.mjs",
  withTempIr: async (_ir: unknown, fn: (irPath: string) => unknown) => fn("/tmp/ir.json"),
  runArchify: async () => ({
    stdout: "",
    stderr:
      "archify vendored bin not found at /nonexistent/archify.mjs; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).",
    status: 1,
  }),
}));

const { archifyRender } = await import("../lib/render.ts");

describe("archifyRender — missing vendored bin", () => {
  it("surfaces 'vendored bin not found' and does NOT say 'Validate the IR'", async () => {
    const out = await archifyRender(
      { ir: { diagram_type: "architecture" } },
      { cwd: "/tmp" },
    );
    const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(out.isError).toBe(true);
    expect(text).toContain("vendored bin not found");
    expect(text).not.toContain("Validate the IR");
  });
});
```

> **Note for the implementer:** keep this test in its own file (it already is) and run the full suite with `bun test --isolate` if the mock leaks across files (per the repo's known `mock.module` + isolation behavior). Do not replace the mock with env/dynamic-import tricks — `mock.module` deterministically pins the run.ts shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test __tests__/render-bin-missing.test.ts )`
Expected: FAIL — the current `catch` block at `render.ts:59` prepends `"Validate the IR first with archify_validate."`, so `text` contains `"Validate the IR"` and fails the `.not.toContain` assertion. (The `toContain("vendored bin not found")` may also fail since the current message buries stderr after the IR-validity framing.)

- [ ] **Step 3: Fix the catch block**

In `bun-apps/pi-agent-ext-archify/lib/render.ts`, replace the `catch` block (currently lines 58-60):

```ts
  } catch {
    return { content: [{ type: "text" as const, text: `Error: archify deliver produced non-JSON output (exit ${status}). Validate the IR first with archify_validate.\n${stderr || stdout}` }], details: { error: "deliver non-json", status }, isError: true };
  }
```

with:

```ts
  } catch {
    // Empty stdout means archify never produced output — the bin is missing or
    // failed to load (pre-flight sets stderr to a "vendored bin not found"
    // message). Do NOT blame IR validity in that case; lead with stderr.
    const binMissing = stdout === "";
    const detail = binMissing
      ? stderr
      : `archify deliver produced non-JSON output (exit ${status}). ${stderr || stdout}`;
    return {
      content: [{ type: "text" as const, text: `Error: ${detail}` }],
      details: { error: binMissing ? "vendored bin missing" : "deliver non-json", status },
      isError: true,
    };
  }
```

Leave the `receipt.ok !== true || status !== 0` branch (line 62) unchanged — when the receipt parsed, archify ran and `ok !== true` genuinely implies an IR problem, so "Validate the IR first" there is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test __tests__/render-bin-missing.test.ts )`
Expected: PASS.

- [ ] **Step 5: Run the full archify suite**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test )`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-archify/lib/render.ts bun-apps/pi-agent-ext-archify/__tests__/render-bin-missing.test.ts
git commit -m "fix(archify): render surfaces missing-bin error instead of blaming IR validity

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `scripts/lib/build-extensions.ts` — stage vendored assets into the bundle target

**Files:**
- Modify: `bun-apps/pi-agent/scripts/lib/build-extensions.ts` (imports, `expectedFiles` stale-cleanup set, and a new `stageVendoredAssets` function called from `buildExtensions`)
- Create: `bun-apps/pi-agent/scripts/lib/build-extensions.test.ts`

**Interfaces:**
- Produces: `export function stageVendoredAssets(exts: { name: string; pkgDir: string }[], targetDir: string): void` — copies each ext's `<pkgDir>/vendored/` (if present) to `<targetDir>/vendored/`. Called from `buildExtensions` after the build loop, before the final success log.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/scripts/lib/build-extensions.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageVendoredAssets } from "./build-extensions.ts";

describe("stageVendoredAssets", () => {
  it("copies a package's vendored/ tree into targetDir/vendored/", () => {
    const pkgDir = mkdtempSync(join(tmpdir(), "pkg-"));
    const targetDir = mkdtempSync(join(tmpdir(), "tgt-"));
    mkdirSync(join(pkgDir, "vendored", "bin"), { recursive: true });
    writeFileSync(join(pkgDir, "vendored", "bin", "archify.mjs"), "// stub");
    try {
      stageVendoredAssets([{ name: "pi-agent-ext-archify", pkgDir }], targetDir);
      expect(existsSync(join(targetDir, "vendored", "bin", "archify.mjs"))).toBe(true);
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the package has no vendored/ tree", () => {
    const pkgDir = mkdtempSync(join(tmpdir(), "pkg-novendor-"));
    const targetDir = mkdtempSync(join(tmpdir(), "tgt-novendor-"));
    try {
      stageVendoredAssets([{ name: "no-vendored", pkgDir }], targetDir);
      expect(existsSync(join(targetDir, "vendored"))).toBe(false);
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/build-extensions.test.ts )`
Expected: FAIL — `stageVendoredAssets` is not exported.

- [ ] **Step 3: Implement `stageVendoredAssets` and wire it in**

In `bun-apps/pi-agent/scripts/lib/build-extensions.ts`:

(a) Add `cpSync` to the `node:fs` import (currently imports `existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync`):

```ts
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
```

(b) Exempt `vendored/` from stale-cleanup. In `buildExtensions`, after the `expectedFiles` set is built (currently lines 322-324) and before the cleanup loop, add:

```ts
	const expectedFiles = new Set(
		exts.flatMap((spec) => [`${spec.name}.thin.js`, `${spec.name}.thin.hash`]),
	);
	if (exts.some((spec) => existsSync(join(spec.pkgDir, "vendored")))) {
		expectedFiles.add("vendored");
	}
```

(c) Add the new function near `buildOne` (e.g. just before the `// ── Public API` header):

```ts
/**
 * Copy each extension's `vendored/` tree (if present) into `<targetDir>/vendored/`
 * so the bundled thin file can resolve it at runtime via run.ts's walk-up probe.
 * Today only archify ships a vendored/ tree; if a second extension later adds
 * one, extend to a per-extension subdir + name-aware probe (see design §A2).
 */
export function stageVendoredAssets(
	exts: { name: string; pkgDir: string }[],
	targetDir: string,
): void {
	for (const spec of exts) {
		const vendoredSrc = join(spec.pkgDir, "vendored");
		if (!existsSync(vendoredSrc)) continue;
		const dest = join(targetDir, "vendored");
		cpSync(vendoredSrc, dest, { recursive: true, force: true });
		console.log(`    ✓ vendored/ (from ${spec.name}) → ${dest}`);
	}
}
```

(d) Call it from `buildExtensions` after the build loop, immediately before the final success log (currently `console.log(\`✓ ${exts.length}/...\`)` at line 360):

```ts
	stageVendoredAssets(exts, targetDir);

	console.log(`✓ ${exts.length}/${exts.length} extension(s) built → ${targetDir}`);
	return { count: built + skipped };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test scripts/lib/build-extensions.test.ts )`
Expected: PASS (both specs).

- [ ] **Step 5: Smoke-test the real deploy staging end-to-end**

Run a real bundle build into a scratch target and confirm vendored is staged:

```bash
( cd bun-apps/pi-agent && bun run -e 'import("./scripts/lib/build-extensions.ts").then(async m => { await m.buildExtensions("/tmp/archify-deploy-smoke/ext-bundles"); })' )
```

Then verify:
```bash
ls /tmp/archify-deploy-smoke/ext-bundles/vendored/bin/archify.mjs && echo "STAGED OK"
```
Expected: the file exists (vendored/ copied next to `pi-agent-ext-archify.thin.js`).
Clean up: `rm -rf /tmp/archify-deploy-smoke`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent/scripts/lib/build-extensions.ts bun-apps/pi-agent/scripts/lib/build-extensions.test.ts
git commit -m "feat(deploy): stage vendored/ assets into ext-bundles target (archify deploy-bundle fix)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Cluster B — re-enable the schema-cost canary's coverage of archify

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json` (add `"archify"` to `sourceMinimum`)
- Modify: `bun-apps/pi-agent/scripts/schema-cost-baseline.json` (refresh from measured output)

**No new tests** — verification is the canary itself running clean. Steps must be executed in order; B2/B3 are blocked until B1 passes.

- [ ] **Step 1 (B1): Repair the `@repo/pi-agent-ext-subagent` symlink**

Run from the workspace root:
```bash
( cd bun-apps && bun install )
```

- [ ] **Step 2 (B1 verify): Confirm the canonical canary runs clean**

Run:
```bash
bun scripts/check-schema-cost.ts --threshold 999; echo "exit=$?"
```
Expected: `exit=0` (previously exit 1 with `Cannot find module '@repo/pi-agent-ext-subagent'`).

**STOP CONDITION:** if exit ≠ 0 after a fresh `bun install`, the root cause is a declared-dep problem in `bun-apps/pi-agent-ext-knowledge-card/package.json`, not an install gap. Do NOT proceed to B2/B3. Report the failure with the canary's stderr and halt this task.

- [ ] **Step 3 (B2): Add archify to the boot-smoke baseline**

In `bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json`, add `"archify"` to the `sourceMinimum` array (it currently has 13 entries; archify is registered in `run-dir/manifest.json` but absent). Result:

```json
  "sourceMinimum": [
    "knowledge-card",
    "flux2",
    "web-access",
    "ltx",
    "krea2",
    "movie-director",
    "core-task",
    "file2md",
    "power-tool",
    "research-tool",
    "hermes-memory",
    "obsidian",
    "workflow",
    "archify"
  ]
```

- [ ] **Step 4 (B3): Refresh the schema-cost token baseline**

With the canary running clean (B1 verified), regenerate the enforced baseline:
```bash
bun bun-apps/pi-agent-cli/src/cli.ts tools-metrics --schema-cost --json > bun-apps/pi-agent/scripts/schema-cost-baseline.json
```

Verify archify is present in the refreshed file:
```bash
grep -c archify bun-apps/pi-agent/scripts/schema-cost-baseline.json
```
Expected: `≥ 1`.

- [ ] **Step 5 (B verify): Run the canary against the refreshed baseline**

Run:
```bash
bun scripts/check-schema-cost.ts; echo "exit=$?"
```
Expected: `exit=0`, no `>5% inflation` WARNING (the baseline now includes archify's 515 tokens plus the other previously-un-baselined sources).

- [ ] **Step 6: Run the boot-smoke fixture test**

Run:
```bash
( cd bun-apps/pi-agent-cli && bun test )
```
Expected: PASS — the boot-smoke baseline test accepts the new `archify` source.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json bun-apps/pi-agent/scripts/schema-cost-baseline.json
git commit -m "fix(canary): re-enable schema-cost coverage of archify (symlink + baselines)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final verification

After all four tasks:

- [ ] `( cd bun-apps/pi-agent-ext-archify && bun test )` — all archify tests green.
- [ ] `( cd bun-apps/pi-agent && bun test scripts/lib/build-extensions.test.ts )` — staging test green.
- [ ] `bun scripts/check-schema-cost.ts` — exit 0, archify present, no inflation warning.
- [ ] Optional end-to-end: run a real `deploy-bundle` to a scratch target and invoke `archify_render` through the bundle to confirm the success path (the audit verified the failure path via direct spawnSync; this confirms the fix through the deploy layer).
