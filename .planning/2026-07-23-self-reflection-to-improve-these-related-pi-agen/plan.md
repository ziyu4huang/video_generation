# research-tool vault resolver drift fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `pi-agent-ext-research-tool` from silently writing to `<cwd>` when no vault resolves — re-align its vault resolver to obsidian-lib's Tier-1 set (add the missing `~/.pi` personal tier) and replace the silent cwd fallback with a loud, actionable error, guarded by a parity test.

**Architecture:** research-tool's `lib/vault.ts` `resolveVaultRoot` is re-aligned to the same Tier-1 sources obsidian-lib reads (`OB_VAULT_PATH` env → personal `~/.pi/obsidian_config.json` → project `<cwd>/.pi/obsidian_config.json`). When none resolves it **throws** (a paper/notes tool must not auto-create or chase the Obsidian app's open vault — a deliberate divergence from obsidian-lib's Tier-2/3). A new dev-only `__tests__/vault-parity.test.ts` imports `obsidian-lib.resolveVault` and asserts agreement on every Tier-1 success case, so future tier drift fails the suite loudly. **Runtime stays decoupled** (no cross-ext import); only the test dev-depends on `@repo/pi-agent-ext-obsidian`.

**Tech Stack:** Bun + TypeScript (`moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `noEmit`), `bun:test`, `node:fs`/`node:os`/`node:path`, bun workspaces (`workspace:*` devDep).

## Global Constraints

- **Shell discipline:** never top-level `cd` (blocked by `no-cd-drift.sh`). Use `( cd <dir> && ... )` subshells. `bun install` runs from `bun-apps/`, never the repo root.
- **Decoupling is preserved at runtime:** `lib/vault.ts` MUST NOT import `@repo/pi-agent-ext-obsidian` or any `@earendil-works/*`. Only `__tests__/vault-parity.test.ts` may dev-import obsidian-lib.
- **English artifacts:** code, comments, commit messages in English; conventional-prefix messages (`fix(...)`, `test(...)`, `docs(...)`).
- **All 4 call sites already have explicit-override escape hatches** (`outputPath` / `vaultRoot` / `output_path`) that bypass `resolveVaultRoot` — confirmed via `grep -nE "resolveVaultRoot|resolveWritePath" extensions/research-tool.ts`. Making `resolveVaultRoot` throw does NOT require editing call sites; the error propagates to the tool caller (the pi harness surfaces it). Verification only.
- **One logical change per commit;** branch off `origin/main`.

**Pre-flight (do once before Task 1):** create a feature branch off current `origin/main`:
```bash
( cd /Users/huangziyu/proj/video_generation__tool_gate && git checkout -b fix/research-tool-vault-resolver-drift origin/main )
```

---

## File Structure

- **Modify** `bun-apps/pi-agent-ext-research-tool/lib/vault.ts` — re-align `resolveVaultRoot` tiers (add personal `~/.pi`), swap silent cwd fallback → loud error; rewrite header comment; drop the now-dead `runDirPath()` + run-dir tier + unused imports; add `homeBase()`/`personalConfigPath()`/`projectConfigPath()` mirroring obsidian-lib.
- **Create** `bun-apps/pi-agent-ext-research-tool/__tests__/vault.test.ts` — functional tests (Tier-1a/1b/1c resolve, no-vault throws, escape hatch bypasses).
- **Create** `bun-apps/pi-agent-ext-research-tool/__tests__/vault-parity.test.ts` — drift-guard: asserts parity with obsidian-lib `resolveVault` for Tier-1 success cases.
- **Modify** `bun-apps/pi-agent-ext-research-tool/package.json` — add `"@repo/pi-agent-ext-obsidian": "workspace:*"` to `devDependencies` (parity test only).
- **Modify** `bun-apps/pi-agent-ext-research-tool/README.md` / `CONTEXT.md` — only IF they mention vault tiers / cwd fallback (Task 3 sweeps + rewrites with the canonical tier list).

---

## Task 1: Re-align `resolveVaultRoot` (personal tier + loud error)

**Files:**
- Create: `bun-apps/pi-agent-ext-research-tool/__tests__/vault.test.ts`
- Modify: `bun-apps/pi-agent-ext-research-tool/lib/vault.ts` (full rewrite of the resolver + header; see Step 3)

**Interfaces:**
- Consumes: none (self-contained; `process.env.HOME`, `process.env.OB_VAULT_PATH`, `cwd` arg).
- Produces: `resolveVaultRoot(cwd: string): Promise<string>` — **contract change**: now THROWS when no Tier-1 vault resolves (previously returned `cwd`). `resolveWritePath` / `resolveOutputDir` / `ensureDir` signatures unchanged; `resolveWritePath(cwd, name, outputPath)` still bypasses resolution when `outputPath` is set.

- [ ] **Step 1: Write the failing tests**

Create `bun-apps/pi-agent-ext-research-tool/__tests__/vault.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultRoot, resolveWritePath } from "../lib/vault.ts";

let tmp: string;
let origHome: string | undefined;
let origVault: string | undefined;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "vault-"));
	origHome = process.env.HOME;
	origVault = process.env.OB_VAULT_PATH;
	process.env.HOME = tmp; // personal ~/.pi → <tmp>/.pi
	delete process.env.OB_VAULT_PATH;
});

afterEach(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origVault === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = origVault;
	await rm(tmp, { recursive: true, force: true });
});

test("resolveVaultRoot: OB_VAULT_PATH env resolves (Tier 1a)", async () => {
	const vault = join(tmp, "envvault");
	await mkdir(vault, { recursive: true });
	process.env.OB_VAULT_PATH = vault;
	expect(await resolveVaultRoot(tmp)).toBe(vault);
});

test("resolveVaultRoot: personal ~/.pi vault_path resolves (Tier 1b)", async () => {
	const vault = join(tmp, "myvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(tmp, ".pi"), { recursive: true });
	await writeFile(
		join(tmp, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		expect(await resolveVaultRoot(cwd)).toBe(vault);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveVaultRoot: project <cwd>/.pi vault_path resolves (Tier 1c)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	const vault = join(cwd, "projvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(cwd, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	try {
		expect(await resolveVaultRoot(cwd)).toBe(vault);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveVaultRoot: throws actionable error when no vault resolves", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		let err: unknown;
		try {
			await resolveVaultRoot(cwd);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		expect(msg).toMatch(/No active Obsidian vault resolved/);
		expect(msg).toMatch(/OB_VAULT_PATH/);
		expect(msg).toMatch(/obsidian-config/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveWritePath: explicit outputPath bypasses vault resolution (no throw)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		const out = await resolveWritePath(cwd, "x.md", join(cwd, "out", "x.md"));
		expect(out).toBe(join(cwd, "out", "x.md"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify the expected ones fail**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bun test __tests__/vault.test.ts )`
Expected: **2 FAIL** —
- `personal ~/.pi vault_path resolves (Tier 1b)` — current code has no personal tier → returns `cwd`, not `vault`.
- `throws actionable error when no vault resolves` — current code returns `cwd` instead of throwing.
The other 3 (env, project, escape hatch) PASS against current code.

- [ ] **Step 3: Rewrite `lib/vault.ts` with the re-aligned resolver**

Replace the **entire contents** of `bun-apps/pi-agent-ext-research-tool/lib/vault.ts` with:

```ts
/**
 * Output-directory resolution — re-aligned to the obsidian extension's vault
 * tiers so collected Markdown lands in the SAME active vault the obsidian tools
 * operate on.
 *
 *   Tier 1a. OB_VAULT_PATH env (absolute)
 *   Tier 1b. personal config ~/.pi/obsidian_config.json { vault_path }
 *            (the tier that was MISSING before — the user-global default)
 *   Tier 1c. project config <cwd>/.pi/obsidian_config.json { vault_path }
 *            when mode != "app"
 *
 * DELIBERATE divergence from obsidian-lib.resolveVault: when no Tier-1 vault
 * resolves, this resolver THROWS (a paper/notes tool must not auto-create or
 * seed a vault, nor chase the Obsidian app's open vault). Callers MUST either
 * have a resolvable vault or pass an explicit outputPath/vaultRoot.
 *
 * Drift guard: __tests__/vault-parity.test.ts dev-imports obsidian-lib and
 * asserts this resolver agrees with resolveVault() for every Tier-1 success
 * case. If obsidian-lib's tiers change, that test fails loudly.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";

/** HOME base (honors process.env.HOME for testability; mirrors obsidian-lib._homeBase). */
function homeBase(): string {
	return process.env.HOME || homedir();
}

/** Personal (user-global) config path: ~/.pi/obsidian_config.json. Mirrors obsidian-lib.personalConfigPath. */
function personalConfigPath(): string {
	return join(homeBase(), ".pi", "obsidian_config.json");
}

/** Project (per-cwd) config path: <cwd>/.pi/obsidian_config.json. Mirrors obsidian-lib.projectConfigPath. */
function projectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "obsidian_config.json");
}

interface VaultConfigFile {
	vault_path?: string;
	mode?: "explicit" | "app";
}

async function readConfig(p: string): Promise<VaultConfigFile> {
	try {
		return JSON.parse(await readFile(p, "utf8"));
	} catch {
		return {};
	}
}

/** Resolve the active vault root directory (absolute), or throw an actionable error. */
export async function resolveVaultRoot(cwd: string): Promise<string> {
	// Tier 1a — env
	const envPath = process.env.OB_VAULT_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	// Tier 1b — personal ~/.pi (vault_path only; mode is a project-tier concept)
	const personal = await readConfig(personalConfigPath());
	if (personal.vault_path) {
		const p = isAbsolute(personal.vault_path)
			? personal.vault_path
			: resolve(cwd, personal.vault_path);
		if (existsSync(p)) return p;
	}

	// Tier 1c — project <cwd>/.pi (only when mode != "app")
	const project = await readConfig(projectConfigPath(cwd));
	if (project.mode !== "app" && project.vault_path) {
		const p = isAbsolute(project.vault_path)
			? project.vault_path
			: resolve(cwd, project.vault_path);
		if (existsSync(p)) return p;
	}

	// No resolution — loud, actionable error (never a silent cwd fallback).
	throw new Error(
		`No active Obsidian vault resolved for research-tool. Tried (in order):\n` +
			`  1. OB_VAULT_PATH env — ${envPath ? `"${envPath}" not found` : "not set"}\n` +
			`  2. ${personalConfigPath()} (personal) — ${personal.vault_path ? "path not found" : "not set"}\n` +
			`  3. ${projectConfigPath(cwd)} (project) — ${project.vault_path ? "path not found" : "not set"}\n` +
			`Fix: set OB_VAULT_PATH to your vault, run \`/obsidian-config\` to register a vault, ` +
			`or pass an explicit outputPath/vaultRoot to this tool.`,
	);
}

/** Resolve the weekly-news output directory for the active vault. */
export async function resolveOutputDir(cwd: string): Promise<string> {
	return join(await resolveVaultRoot(cwd), "weekly-news");
}

/**
 * Resolve the final file path to write.
 * - If `outputPath` is given (absolute or cwd-relative), use it verbatim.
 * - Otherwise derive <vaultRoot>/weekly-news/<filename>.
 */
export async function resolveWritePath(
	cwd: string,
	filename: string,
	outputPath?: string,
): Promise<string> {
	if (outputPath) return isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
	return join(await resolveOutputDir(cwd), filename);
}

/** Ensure a directory exists (mkdir -p). */
export async function ensureDir(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bun test __tests__/vault.test.ts )`
Expected: **5 PASS**.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bunx tsc --noEmit )`
Expected: no output, exit 0. (If it errors on the removed `runDirPath`/`dirname`/`fileURLToPath` being referenced elsewhere, those references are dead — confirm with `grep -nE "runDirPath|fileURLToPath|dirname" lib/vault.ts` returns nothing.)

- [ ] **Step 6: Commit**

```bash
( cd /Users/huangziyu/proj/video_generation__tool_gate && \
  git add bun-apps/pi-agent-ext-research-tool/lib/vault.ts \
          bun-apps/pi-agent-ext-research-tool/__tests__/vault.test.ts && \
  git commit -m "fix(research-tool): re-align vault resolver tiers + loud error

Add the missing personal ~/.pi/obsidian_config.json tier so a user-global
vault config is no longer invisible. Replace the silent <cwd> fallback with
a loud, actionable error (paper/notes tool must not auto-create a vault).
Drop the retired run-dir tier + dead runDirPath(). Runtime stays decoupled;
parity is guarded by vault-parity.test.ts (next commit)." )
```

---

## Task 2: Drift-guard parity test (cross-check obsidian-lib)

**Files:**
- Modify: `bun-apps/pi-agent-ext-research-tool/package.json` (`devDependencies` += `@repo/pi-agent-ext-obsidian`)
- Create: `bun-apps/pi-agent-ext-research-tool/__tests__/vault-parity.test.ts`

**Interfaces:**
- Consumes: `resolveVaultRoot` from Task 1; `resolveVault` from `@repo/pi-agent-ext-obsidian/src/obsidian-lib.ts` (value import; safe under `verbatimModuleSyntax`).
- Produces: a regression guard — fails loudly if research-tool's Tier-1 tiers ever drift from obsidian-lib's.

**Pitfall:** obsidian-lib's `resolveVault` does Tier-2 (follow Obsidian app open vault) / Tier-3 (auto-create `./vault`) when Tier-1 misses. This test ONLY covers Tier-1 SUCCESS setups (where obsidian-lib returns at Tier 1), so it never reaches the divergent fallback. Do NOT add a "nothing set" parity case — that divergence lives in `vault.test.ts` (research-tool throws).

- [ ] **Step 1: Add the dev dependency**

Edit `bun-apps/pi-agent-ext-research-tool/package.json` — add to `devDependencies`:
```json
    "devDependencies": {
      "@repo/pi-agent-ext-obsidian": "workspace:*",
      "@types/bun": "latest",
      "typescript": "^6.0.3"
    }
```

- [ ] **Step 2: Install (from bun-apps/, never repo root)**

Run: `( cd bun-apps && bun install )`
Expected: resolves `@repo/pi-agent-ext-obsidian` via the workspace symlink; `bun.lock` updated.

- [ ] **Step 3: Write the parity test**

Create `bun-apps/pi-agent-ext-research-tool/__tests__/vault-parity.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultRoot } from "../lib/vault.ts";
import { resolveVault as obsidianResolveVault } from "@repo/pi-agent-ext-obsidian/src/obsidian-lib.ts";

// Drift guard: research-tool's resolver must agree with obsidian-lib.resolveVault
// for every Tier-1 success case (env / personal ~/.pi / project <cwd>/.pi).
// The no-vault case deliberately diverges (research-tool throws; obsidian-lib
// auto-creates a Tier-3 ./vault) — that divergence lives in vault.test.ts.

let tmp: string;
let origHome: string | undefined;
let origVault: string | undefined;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "vparity-"));
	origHome = process.env.HOME;
	origVault = process.env.OB_VAULT_PATH;
	process.env.HOME = tmp;
	delete process.env.OB_VAULT_PATH;
});

afterEach(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origVault === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = origVault;
	await rm(tmp, { recursive: true, force: true });
});

test("parity: OB_VAULT_PATH env — research-tool == obsidian-lib", async () => {
	const vault = join(tmp, "envvault");
	await mkdir(vault, { recursive: true });
	process.env.OB_VAULT_PATH = vault;
	expect(await resolveVaultRoot(tmp)).toBe((await obsidianResolveVault(tmp)).path);
});

test("parity: personal ~/.pi — research-tool == obsidian-lib", async () => {
	const vault = join(tmp, "pervault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(tmp, ".pi"), { recursive: true });
	await writeFile(
		join(tmp, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		expect(await resolveVaultRoot(cwd)).toBe((await obsidianResolveVault(cwd)).path);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("parity: project <cwd>/.pi — research-tool == obsidian-lib", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	const vault = join(cwd, "projvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(cwd, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	try {
		expect(await resolveVaultRoot(cwd)).toBe((await obsidianResolveVault(cwd)).path);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
```

- [ ] **Step 4: Run the parity test**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bun test __tests__/vault-parity.test.ts )`
Expected: **3 PASS**. (If any FAILS, Task 1's re-alignment did not match obsidian-lib's Tier-1 — re-read `obsidian-lib.ts` `resolveVault` at line 356 and align the tier order/conditions exactly, then re-run.)

- [ ] **Step 5: Typecheck (import resolves under bundler resolution)**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bunx tsc --noEmit )`
Expected: exit 0. **Pitfall:** if tsc errors on the `@repo/pi-agent-ext-obsidian/src/obsidian-lib.ts` import (e.g. obsidian-lib source triggers strict errors under this tsconfig), do NOT loosen runtime code — instead confirm `bun install` linked the workspace (Step 2) and that the obsidian package's `"exports"` still maps `"./src/*": "./src/*"`. `skipLibCheck: true` does not skip `.ts` source, so a genuine obsidian-lib type error would need a tsconfig `paths`/exclude carve-out; report it rather than papering over.

- [ ] **Step 6: Commit**

```bash
( cd /Users/huangziyu/proj/video_generation__tool_gate && \
  git add bun-apps/pi-agent-ext-research-tool/package.json \
          bun-apps/pi-agent-ext-research-tool/__tests__/vault-parity.test.ts \
          bun-apps/bun.lock && \
  git commit -m "test(research-tool): add obsidian-lib parity drift-guard

Dev-import obsidian-lib.resolveVault and assert research-tool's resolver
agrees for every Tier-1 success case (env / personal ~/.pi / project).
Future tier drift fails the suite loudly. Runtime stays decoupled — only
this test dev-depends on @repo/pi-agent-ext-obsidian." )
```

---

## Task 3: Doc sweep + full-suite verification

**Files:**
- Modify (conditionally): `bun-apps/pi-agent-ext-research-tool/README.md`, `bun-apps/pi-agent-ext-research-tool/CONTEXT.md`

**Interfaces:** none (verification + doc accuracy only).

- [ ] **Step 1: Sweep README/CONTEXT for stale vault-tier / cwd-fallback mentions**

Run: `( cd bun-apps/pi-agent-ext-research-tool && grep -nEi "cwd fallback|tier 2|<cwd>|run-dir.*obsidian_config|decoupled.*no cross" README.md CONTEXT.md )`
Expected: either no matches (nothing to update — skip to Step 3) OR matches that reference the OLD behavior (silent cwd fallback / "decoupled: no cross-package import" / run-dir tier). For any match, replace the stale description with the canonical tier list:

> Vault resolution (research-tool): `OB_VAULT_PATH` env → `~/.pi/obsidian_config.json` (personal) → `<cwd>/.pi/obsidian_config.json` (project, `mode != "app"`) → **throws** (no silent cwd fallback). Runtime is decoupled from `pi-agent-ext-obsidian`; a dev-only parity test guards against tier drift.

If the README "Output" / "Architecture" section or CONTEXT.md glossary mentions the tiers, rewrite to the above. If neither file mentions tiers, do nothing and skip the commit in Step 4.

- [ ] **Step 2: Run the FULL test suite for the package**

Run: `( cd bun-apps/pi-agent-ext-research-tool && bun test )`
Expected: **all pass** (existing arxiv/bilibili-wbi/filter/format/organize/import-memory/cli-subcommand tests + new vault + vault-parity).

- [ ] **Step 3: Confirm the 4 call sites propagate cleanly (no swallow)**

Run: `( cd bun-apps/pi-agent-ext-research-tool && grep -nA1 -E "resolveVaultRoot|resolveWritePath" extensions/research-tool.ts )`
Confirm each of the 4 call sites either (a) is guarded by an explicit-override param (`params.outputPath` / `params.vaultRoot` / `params.output_path`) that bypasses `resolveVaultRoot`, or (b) lets the throw propagate to the tool caller. No site wraps it in a `try/catch` that would swallow the error. (No code change expected — this is verification; the `resolveWritePath` escape-hatch test in Task 1 already covers the bypass path.)

- [ ] **Step 4: Commit (only if Step 1 changed docs)**

```bash
( cd /Users/huangziyu/proj/video_generation__tool_gate && \
  git add bun-apps/pi-agent-ext-research-tool/README.md \
          bun-apps/pi-agent-ext-research-tool/CONTEXT.md && \
  git commit -m "docs(research-tool): update vault-resolution tier notes" ) || \
  echo "No doc changes — skip commit"
```

---

## Self-Review

**1. Spec coverage** (vs. ticket [03] resolution + map destination):
- "Re-align tiers to obsidian-lib's canonical set (add `~/.pi` personal)" → Task 1 Step 3 (Tier 1b). ✓
- "Replace silent cwd fallback with loud, actionable error" → Task 1 Step 3 (throw) + tested Task 1 (`throws actionable error`). ✓
- "Keep explicit-override escape hatch" → Task 1 (`resolveWritePath: explicit outputPath bypasses`) + Task 3 Step 3 (verify all 4 call sites). ✓
- "Drift-detector contract test (dev-only parity)" → Task 2. ✓
- "Rewrite the now-false header comment" → Task 1 Step 3 (full file incl. new header). ✓
- Destination ("never silently land wrong: succeed / error loudly / explicit override") → throw on no-resolve (error loudly) + escape hatch (explicit override) + Tier-1 (succeed). ✓

**2. Placeholder scan:** no TBD/TODO; every code step has full code; every command has expected output; the one conditional (`|| echo skip`) is a real branch, not a placeholder. ✓

**3. Type consistency:** `resolveVaultRoot(cwd: string): Promise<string>` (throws) — consistent across Task 1 tests, Task 2 parity test, and the 4 call sites. `resolveWritePath(cwd, filename, outputPath?)` signature unchanged. `obsidianResolveVault(cwd)` returns `ResolvedVault` — parity compares `.path`. `VaultConfigFile { vault_path?, mode? }` matches the JSON the tests write. ✓

**Note on relative `vault_path`:** both resolvers resolve a relative personal `vault_path` against `cwd`; registered vaults are overwhelmingly absolute, so parity holds for realistic configs. The parity tests use absolute paths, matching real usage. (A relative personal `vault_path` is an unsupported edge; not in scope.)
