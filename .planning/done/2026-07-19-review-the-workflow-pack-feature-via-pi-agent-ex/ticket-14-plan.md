# Workflow-Pack Self-Contained Unit — Implementation Plan (ticket 14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundational, independently-testable layer that makes a workflow-pack a self-contained, agent-cleanable unit — manifest I/O contract, pack identity, bundled-agent registration, pack-local state resolver, clean/purge surface, backward-compat branch, scaffolder+template, and a reference pack exercising all of it.

**Architecture:** Pure, injectable functions (no network, no LLM) so every task is hermetically TDD-able. Each unit ships its own contract test against the built `dist/`. The resolver/persistence stay backward-compatible (inline scripts untouched) via a `packId` branch. The shipped `workflow-pack/template/` is added to `package.json` `files:` so consumers reach it.

**Tech Stack:** TypeScript, Bun (test runner + runtime), Biome (lint/format), `@earendil-works/pi-coding-agent`. Tests: `( cd bun-apps/pi-agent-ext-workflow && bun test )`. Build: `bun run build` (=`bunx tsc`). Lint: `biome check .`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Test cmd: `( cd bun-apps/pi-agent-ext-workflow && bun test )`.
- **Verify against built `dist/`, not `src/`** where a contract spans the published surface (the manifest/resolver are consumed via `dist/`).
- **TDD iron law** — no production code without a failing test first; watch it fail for the right reason.
- **`.pi` is NOT gitignored in this repo** → the pack template MUST ship a `.gitignore` for its ephemeral dirs (`outputs/ intermediate/ runs/`).
- **Backward-compat is absolute** — inline `script:` runs + existing `~/.pi/workflows/projects/<key>/` state are byte-identical in behavior (13). A `packId`-absent run uses `createRunPersistence(cwd)` unchanged.
- **Naming/identity:** `packId = ${sanitize(name)}-${sha256(absPath).slice(0,12)}` (08), version-INDEPENDENT. State redirect target for checked-in packs: `.pi/workflows/.state/<packId>/` (project-local, never `~/.pi`).
- **Agent security fix (09):** `tools` frontmatter accepts YAML array OR comma-separated string; a string MUST be split (never silently become "all tools"). Backward-compatible (array still works).
- **Precedence:** agent defs `project > pack > user` (09); name collision `pack wins + warn` (13).
- **Retention vocab (06):** `all` (default) | `last-N` (`--keep N`). Clean default scope = `intermediate` (safe tier); `runs`/`outputs` require `--scope` + dry-run-default + `--yes`.
- **DRY, YAGNI, frequent commits** — one logical commit per task.
- **No placeholders** — every code step shows real code.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `src/workflow-pack-manifest.ts` | + `version`, `agents`, `io` fields + validation | T1 |
| `src/workflow-pack-id.ts` | NEW — `packId(name, absPath)` pure derivation | T2 |
| `src/agent-registry.ts` | `tools` array+string fix; `packDirs` + `source:"pack"`; precedence | T3 |
| `src/pack-state.ts` | NEW — `packStateRoot()` in-place vs redirect + lazy mkdir | T4 |
| `src/workflow-pack-clean.ts` | NEW — `inspectPack()` + `cleanPack()` (3-tier safety) | T5 |
| `src/run-persistence.ts` | + `PersistedRunState.packId?` field | T6 |
| `src/workflow-pack-init.ts` | NEW — `scaffoldPack()` copy template + empty dirs | T7 |
| `workflow-pack/template/*` | NEW shipped template (manifest stub, entry stub, agents/, README, .gitignore) | T7 |
| `package.json` | + `workflow-pack/` to `files:` | T7 |
| `samples/reference-pack/*` | NEW reference pack exercising manifest/agents/state/clean | T8 |
| `tests/*.test.ts` | one contract test file per unit | each |

**Dependency order:** T1 (manifest) · T2 (packId) · T3 (agent-registry) are independent → T4 (pack-state) needs T1+T2 → T5 (clean) needs T4+T1 → T6 (run-state) needs T2 → T7 (scaffolder+template+files) needs T1 → T8 (reference pack) needs all.

---

### Task 1: Manifest `io` + `version` + `agents` fields

**Files:**
- Modify: `src/workflow-pack-manifest.ts`
- Test: `tests/workflow-pack-manifest.test.ts`

**Interfaces:**
- Produces: `Manifest` gains `version?: string`, `agents?: string`, `io?: ManifestIo`. `validateManifest` accepts + validates them (lenient — schema/vocab only, per 05). `agents` defaults to `"agents/*.md"` at consume time (not stored when absent; consumer applies the default).

- [ ] **Step 1: Write the failing test** (append to `tests/workflow-pack-manifest.test.ts`)

```ts
import { validateManifest } from "../src/workflow-pack-manifest.js";

test("validateManifest accepts version, agents, and io block", () => {
  const m = validateManifest({
    name: "demo", description: "d", entry: "entry.js",
    version: "0.1.0",
    agents: "agents/*.md",
    io: {
      inputs: "inputs/",
      outputs: { naming: "timestamped", retention: "last-N" },
      intermediate: { persist: true, retention: "purge-after-run" },
      runs: { retention: "all" },
    },
  });
  expect(m.version).toBe("0.1.0");
  expect(m.agents).toBe("agents/*.md");
  expect(m.io?.outputs?.naming).toBe("timestamped");
  expect(m.io?.intermediate?.persist).toBe(true);
});

test("validateManifest rejects a non-string version", () => {
  expect(() => validateManifest({ name: "d", description: "d", entry: "e.js", version: 1 }))
    .toThrow(/version/);
});

test("validateManifest omits io/version/agents when not supplied", () => {
  const m = validateManifest({ name: "d", description: "d", entry: "e.js" });
  expect("io" in m).toBe(false);
  expect("version" in m).toBe(false);
  expect("agents" in m).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-manifest.test.ts )`
Expected: FAIL — `version`/`io` not assignable to `Manifest`; property access undefined.

- [ ] **Step 3: Write minimal implementation** (add to `src/workflow-pack-manifest.ts`)

```ts
// Add to the Manifest interface (after `engine?: string;`):
  /** Optional pack version (semver recommended; metadata only, not part of packId). */
  version?: string;
  /** Glob for bundled agent defs, relative to pack dir. Default "agents/*.md". */
  agents?: string;
  /** Optional I/O contract — where inputs/outputs/intermediate/runs live + retention. */
  io?: ManifestIo;

/** I/O contract (05) — all optional; schema/vocab only, semantics live in the runner. */
export interface ManifestIo {
  /** Input source(s): a dir/glob string, a slot object, or an array of either. */
  inputs?: unknown;
  outputs?: { dir?: string; naming?: "timestamped" | "versioned" | "overwrite"; retention?: "all" | "last-N" };
  intermediate?: { persist?: boolean; retention?: "all" | "last-N" | "purge-after-run" };
  runs?: { retention?: "all" | "last-N" };
}
```

In `validateManifest`, after the existing optional-string checks, add:

```ts
  if (hasBadString(obj, "version")) throw new Error('manifest: optional field "version" must be a string');
  if (hasEmptyString(obj, "version")) throw new Error('manifest: optional field "version" must be a non-empty string');
  if (hasBadString(obj, "agents")) throw new Error('manifest: optional field "agents" must be a string');
  if (hasEmptyString(obj, "agents")) throw new Error('manifest: optional field "agents" must be a non-empty string');
  // io: validate only the known shape (lenient — inputs is free-form per 05).
  if ("io" in obj && obj.io !== undefined) {
    const io = obj.io;
    if (typeof io !== "object" || io === null || Array.isArray(io)) {
      throw new Error('manifest: optional field "io" must be an object');
    }
  }
```

And in the returned `manifest` object, add the three carry-through lines:

```ts
  if (obj.version !== undefined) manifest.version = obj.version as string;
  if (obj.agents !== undefined) manifest.agents = obj.agents as string;
  if (obj.io !== undefined) manifest.io = obj.io as ManifestIo;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-manifest.test.ts )`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack-manifest.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack-manifest.test.ts
git commit -m "feat(workflow-pack): manifest io/version/agents fields (ticket 14, T1)"
```

---

### Task 2: `packId` derivation

**Files:**
- Create: `src/workflow-pack-id.ts`
- Test: `tests/workflow-pack-id.test.ts`

**Interfaces:**
- Produces: `packId(name: string, absPath: string): string` → `${sanitize(name)}-${sha256(absPath).slice(0,12)}`. Version-INDEPENDENT. Mirrors `workflowProjectKey` (08).

- [ ] **Step 1: Write the failing test**

```ts
// tests/workflow-pack-id.test.ts
import { packId } from "../src/workflow-pack-id.js";

test("packId is name + 12-char path hash, stable per absolute path", () => {
  const id = packId("audit", "/repo/.pi/workflows/audit");
  expect(id).toBe("audit-" + "a".repeat(0) + expect.stringMatching(/^[0-9a-f]{12}$/));
  expect(id.startsWith("audit-")).toBe(true);
  // stable
  expect(packId("audit", "/repo/.pi/workflows/audit")).toBe(id);
});

test("packId differs across locations (same name, different path)", () => {
  const a = packId("audit", "/repo/.pi/workflows/audit");
  const b = packId("audit", "/repo/bun-apps/pkgA/workflows/audit");
  expect(a).not.toBe(b);
});

test("packId is version-independent (deterministic, no version input)", () => {
  // packId takes only (name, absPath) — there is no version parameter.
  expect(packId("x", "/p").split("-").length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-id.test.ts )`
Expected: FAIL — module `../src/workflow-pack-id.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/workflow-pack-id.ts
/**
 * workflow-pack-id.ts — stable pack identity (08).
 *
 * packId = <name-slug>-<sha256(absolutePath).slice(0,12)>. Version-INDEPENDENT
 * (bumping manifest `version` never changes packId, so it never orphans
 * runs/outputs). Disambiguates same-named packs across locations. Mirrors
 * workflowProjectKey (slug-hash). Pure.
 */
import { createHash } from "node:crypto";

export function packId(name: string, absPath: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "pack";
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-id.test.ts )`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack-id.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack-id.test.ts
git commit -m "feat(workflow-pack): packId derivation (ticket 14, T2)"
```

---

### Task 3: Agent-registry `tools` fix (security) + `packDirs` + pack precedence

**Files:**
- Modify: `src/agent-registry.ts`
- Test: `tests/agent-registry.test.ts`

**Interfaces:**
- Produces: `toStringArray` accepts array OR comma-string (splits + trims). `AgentDefinition.source` extends to `"project" | "pack" | "user"`. `loadAgentRegistry(cwd, opts?)` gains `opts.packDirs?: string[]`; precedence `project > pack > user`.

- [ ] **Step 1: Write the failing test** (append to `tests/agent-registry.test.ts`)

```ts
import { parseAgentDefinition, loadAgentRegistry } from "../src/agent-registry.js";

test("parseAgentDefinition splits a comma-string tools field (CC-style) into an allowlist", () => {
  const def = parseAgentDefinition(
    "---\nname: auditor\ntools: Write, Edit, Bash\n---\nYou audit.",
    "project", "auditor.md",
  );
  expect(def?.tools).toEqual(["Write", "Edit", "Bash"]); // NOT undefined (all-tools)
});

test("parseAgentDefinition keeps a YAML array tools field unchanged", () => {
  const def = parseAgentDefinition(
    "---\nname: auditor\ntools: [Write, Edit]\n---\nYou audit.",
    "project", "auditor.md",
  );
  expect(def?.tools).toEqual(["Write", "Edit"]);
});

test("loadAgentRegistry: pack defs load from packDirs with source 'pack', project wins over pack", () => {
  // Use a temp project dir + pack dir via opts overrides.
  const projectDir = "tests/fixtures/agents-project"; // has "shared.md"
  const packDir = "tests/fixtures/agents-pack";       // has "shared.md" + "packonly.md"
  const reg = loadAgentRegistry("/cwd", { projectDir, packDirs: [packDir], userDir: "tests/fixtures/agents-user" });
  expect(reg.get("shared")?.source).toBe("project"); // project > pack
  expect(reg.get("packonly")?.source).toBe("pack");
  expect(reg.get("useronly")?.source).toBe("user");
});
```

(Commit the three fixture dirs — each with a tiny `.md` agent def — as part of the test step.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/agent-registry.test.ts )`
Expected: FAIL — comma-string test gets `tools: undefined`; `packDirs` option does not exist.

- [ ] **Step 3: Write minimal implementation** (edit `src/agent-registry.ts`)

Change `toStringArray`:

```ts
function toStringArray(value: unknown): string[] | undefined {
  // Accept a YAML array OR a Claude-Code-style comma-separated string (09).
  // A string is split on commas + trimmed; empty entries dropped. This fixes
  // the silent "no allowlist = all tools" security trap.
  if (typeof value === "string") {
    const arr = value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    return arr.length ? arr : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return arr.length ? arr : undefined;
}
```

Extend `AgentDefinition.source`:

```ts
  source: "project" | "pack" | "user";
```

Extend `loadAgentRegistry` signature + body (project → pack → user):

```ts
export function loadAgentRegistry(
  cwd: string,
  opts?: { projectDir?: string; userDir?: string; packDirs?: string[] },
): AgentRegistry {
  const projectDir = opts?.projectDir ?? join(cwd, AGENTS_DIR);
  const userDir = opts?.userDir ?? join(homeDir(), AGENTS_DIR);
  const packDirs = opts?.packDirs ?? [];
  const registry: AgentRegistry = new Map();
  for (const def of readDefsFromDir(projectDir, "project")) {
    if (def.name && !registry.has(def.name)) registry.set(def.name, def);
  }
  for (const dir of packDirs) {
    for (const def of readDefsFromDir(dir, "pack")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  if (userDir !== projectDir && !packDirs.includes(userDir)) {
    for (const def of readDefsFromDir(userDir, "user")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  return registry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/agent-registry.test.ts )`
Expected: PASS (all, incl. new).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/agent-registry.ts bun-apps/pi-agent-ext-workflow/tests/agent-registry.test.ts bun-apps/pi-agent-ext-workflow/tests/fixtures/
git commit -m "fix(agent-registry): tools comma-string + packDirs + pack precedence (ticket 14, T3)"
```

---

### Task 4: Pack-state root resolver (in-place vs redirect + lazy mkdir)

**Files:**
- Create: `src/pack-state.ts`
- Test: `tests/pack-state.test.ts`

**Interfaces:**
- Consumes: `packId` (T2).
- Produces: `packStateRoot({ packDir, name, repoRoot, fs? }): { root: string; redirected: boolean }`. If `packDir` is under `<repoRoot>/.pi/workflows/` → in-place (root = packDir, redirected=false). Else (checked-in, e.g. `bun-apps/<pkg>/workflows/`) → redirect to `<repoRoot>/.pi/workflows/.state/<packId>/` (redirected=true). `ensureStateDirs(root, fs?)` does idempotent `mkdir -p` for `runs/ outputs/ intermediate/`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pack-state.test.ts
import { packStateRoot, ensureStateDirs } from "../src/pack-state.js";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a .pi/workflows pack uses in-place state (redirected=false)", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-"));
  const packDir = join(root, ".pi", "workflows", "demo");
  const r = packStateRoot({ packDir, name: "demo", repoRoot: root });
  expect(r.redirected).toBe(false);
  expect(r.root).toBe(packDir);
  rmSync(root, { recursive: true, force: true });
});

test("a checked-in pack (bun-apps/<pkg>/workflows) redirects to .pi/workflows/.state/<packId>", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-"));
  const packDir = join(root, "bun-apps", "pkgA", "workflows", "demo");
  const r = packStateRoot({ packDir, name: "demo", repoRoot: root });
  expect(r.redirected).toBe(true);
  expect(r.root).toBe(join(root, ".pi", "workflows", ".state", expect.stringMatching(/^demo-[0-9a-f]{12}$/)));
  rmSync(root, { recursive: true, force: true });
});

test("ensureStateDirs idempotently creates runs/outputs/intermediate", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-"));
  const state = join(root, "state");
  ensureStateDirs(state);
  ensureStateDirs(state); // idempotent
  expect(existsSync(join(state, "runs"))).toBe(true);
  expect(existsSync(join(state, "outputs"))).toBe(true);
  expect(existsSync(join(state, "intermediate"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-state.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pack-state.ts
/**
 * pack-state.ts — resolve a pack's runtime-state root (03/07).
 *
 * .pi/workflows packs → in-place state inside the pack folder (redirected=false).
 * Checked-in packs (bun-apps/<pkg>/workflows, can't hold writable state) → redirect
 * to <repoRoot>/.pi/workflows/.state/<packId>/ (project-local, never ~/.pi).
 * Lazy self-provisioning: ensureStateDirs mkdir -p's runs/outputs/intermediate.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { packId } from "./workflow-pack-id.js";

const PI_WORKFLOWS = join(".pi", "workflows");

export function packStateRoot(args: {
  packDir: string;
  name: string;
  repoRoot: string;
}): { root: string; redirected: boolean } {
  const piWorkflowsRoot = join(args.repoRoot, PI_WORKFLOWS);
  const rel = relative(piWorkflowsRoot, args.packDir);
  // If packDir lives under <repoRoot>/.pi/workflows/..., state is in-place.
  if (rel && !rel.startsWith("..") && !relative(args.repoRoot, args.packDir).startsWith("..")) {
    return { root: args.packDir, redirected: false };
  }
  const id = packId(args.name, args.packDir);
  return { root: join(piWorkflowsRoot, ".state", id), redirected: true };
}

export function ensureStateDirs(stateRoot: string): void {
  for (const d of ["runs", "outputs", "intermediate"]) {
    mkdirSync(join(stateRoot, d), { recursive: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-state.test.ts )`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/pack-state.ts bun-apps/pi-agent-ext-workflow/tests/pack-state.test.ts
git commit -m "feat(workflow-pack): pack-state root resolver + lazy mkdir (ticket 14, T4)"
```

---

### Task 5: Clean/inspect surface (3-tier safety)

**Files:**
- Create: `src/workflow-pack-clean.ts`
- Test: `tests/workflow-pack-clean.test.ts`

**Interfaces:**
- Consumes: `packStateRoot`/`ensureStateDirs` (T4), `Manifest.io.*.retention` (T1).
- Produces: `inspectPack({ packDir, name, repoRoot, fs? }): PackInspection` (sizes of runs/outputs/intermediate, last-run status). `cleanPack({ packDir, name, repoRoot, scope, keep?, dryRun?, yes?, fs? }): CleanReport`. Default `scope="intermediate"` (safe). `scope=runs|outputs|all` → `dryRun` defaults true; executes only when `yes===true`. Reuses `RunPersistence.delete`-style removal (delete files, not the journal — see 12: mirror disposable).

- [ ] **Step 1: Write the failing test**

```ts
// tests/workflow-pack-clean.test.ts
import { inspectPack, cleanPack } from "../src/workflow-pack-clean.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makePack(withFiles: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cl-"));
  const packDir = join(root, ".pi", "workflows", "demo");
  mkdirSync(join(packDir, "intermediate"), { recursive: true });
  mkdirSync(join(packDir, "outputs"), { recursive: true });
  mkdirSync(join(packDir, "runs"), { recursive: true });
  for (const [rel, content] of Object.entries(withFiles)) writeFileSync(join(packDir, rel), content);
  return { root, packDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("inspectPack reports counts/sizes of the three state dirs", () => {
  const p = makePack({ "intermediate/a.txt": "x", "intermediate/b.txt": "yy", "outputs/o.txt": "z" });
  const ins = inspectPack({ packDir: p.packDir, name: "demo", repoRoot: p.root });
  expect(ins.intermediate.files).toBe(2);
  expect(ins.outputs.files).toBe(1);
  expect(ins.runs.files).toBe(0);
  p.cleanup();
});

test("bare cleanPack (scope=intermediate) purges intermediates, dryRun=false executes without --yes", () => {
  const p = makePack({ "intermediate/a.txt": "x", "outputs/o.txt": "z" });
  const report = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root });
  expect(report.scope).toBe("intermediate");
  expect(report.removed).toBe(1);
  p.cleanup();
});

test("cleanPack scope=runs is dry-run by default; requires yes:true to execute", () => {
  const p = makePack({ "runs/r1.json": "{}" });
  const dry = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs" });
  expect(dry.dryRun).toBe(true);
  expect(dry.removed).toBe(0);
  const exec = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", yes: true });
  expect(exec.dryRun).toBe(false);
  expect(exec.removed).toBe(1);
  p.cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-clean.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/workflow-pack-clean.ts
/**
 * workflow-pack-clean.ts — inspect/clean/purge a pack's state (06).
 *
 * Three-tier safety: intermediate🟢 (safe, default scope, no confirm),
 * runs🟡 + outputs🟠 (lossy; dry-run by default, require yes:true). The journal
 * (runs/<runId>.json) is the resume source-of-truth (12); purging intermediate
 * mirrors is always safe. Retention vocab: all (default) | last-N (--keep N).
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { packStateRoot, ensureStateDirs } from "./pack-state.js";

export type CleanScope = "intermediate" | "outputs" | "runs" | "all";

export interface PackInspection {
  intermediate: { files: number; bytes: number };
  outputs: { files: number; bytes: number };
  runs: { files: number; bytes: number };
}

export interface CleanReport {
  scope: CleanScope;
  dryRun: boolean;
  removed: number;
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) { files++; bytes += statSync(join(dir, e.name)).size; }
  }
  return { files, bytes };
}

export function inspectPack(args: { packDir: string; name: string; repoRoot: string }): PackInspection {
  const { root } = packStateRoot(args);
  ensureStateDirs(root);
  return {
    intermediate: dirStats(join(root, "intermediate")),
    outputs: dirStats(join(root, "outputs")),
    runs: dirStats(join(root, "runs")),
  };
}

export function cleanPack(args: {
  packDir: string; name: string; repoRoot: string;
  scope?: CleanScope; keep?: number; dryRun?: boolean; yes?: boolean;
}): CleanReport {
  const scope: CleanScope = args.scope ?? "intermediate";
  const { root } = packStateRoot(args);
  ensureStateDirs(root);
  const lossy = scope === "runs" || scope === "outputs" || scope === "all";
  const dryRun = args.dryRun ?? lossy; // lossy tiers default to dry-run
  const willExecute = !dryRun || args.yes === true;
  const targets = scope === "all" ? ["intermediate", "outputs", "runs"] : [scope];
  let removed = 0;
  for (const t of targets) {
    const dir = join(root, t);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir);
    if (!willExecute) continue; // dry-run: count, remove nothing
    for (const e of entries) rmSync(join(dir, e), { recursive: true, force: true });
    removed += entries.length;
  }
  return { scope, dryRun: !willExecute, removed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-clean.test.ts )`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack-clean.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack-clean.test.ts
git commit -m "feat(workflow-pack): clean/inspect surface, 3-tier safety (ticket 14, T5)"
```

---

### Task 6: Backward-compat `packId` on run state

**Files:**
- Modify: `src/run-persistence.ts`
- Test: `tests/run-persistence.test.ts`

**Interfaces:**
- Consumes: conceptually `packId` (T2) — set by the runner when pack-sourced; absent for inline.
- Produces: `PersistedRunState.packId?: string`. The field's PRESENCE is the branch signal (13); this task adds the field + a round-trip test (the persistence-factory branch is wired in the runner integration, deferred — see "Out of 14 scope" below).

- [ ] **Step 1: Write the failing test** (append to `tests/run-persistence.test.ts`)

```ts
test("PersistedRunState round-trips an optional packId", () => {
  const { createRunPersistence, generateRunId } = await import("../src/run-persistence.js");
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  const p = createRunPersistence(dir);
  const runId = generateRunId();
  p.save({
    runId, workflowName: "w", script: "s", status: "running", phases: [], agents: [], logs: [],
    startedAt: new Date().toISOString(), packId: "demo-abcdef012345",
  } as any);
  const loaded = p.load(runId);
  expect(loaded?.packId).toBe("demo-abcdef012345");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/run-persistence.test.ts )`
Expected: FAIL — `packId` not assignable to `PersistedRunState`.

- [ ] **Step 3: Write minimal implementation** (add to `PersistedRunState` in `src/run-persistence.ts`)

```ts
  /** Pack identity (08) when this run is pack-sourced; ABSENT for inline scripts.
   *  Presence is the branch signal (13): packId set → pack-local state; absent →
   *  unchanged createRunPersistence(cwd) (~/.pi/workflows/projects/<key>/). */
  packId?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/run-persistence.test.ts )`
Expected: PASS (round-trip preserves packId; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/run-persistence.ts bun-apps/pi-agent-ext-workflow/tests/run-persistence.test.ts
git commit -m "feat(run-persistence): packId field, backward-compat branch signal (ticket 14, T6)"
```

---

### Task 7: Scaffolder `init` + shipped template + `files:`

**Files:**
- Create: `workflow-pack/template/manifest.json`, `workflow-pack/template/entry.js`, `workflow-pack/template/agents/.gitkeep`, `workflow-pack/template/README.md`, `workflow-pack/template/.gitignore`
- Create: `src/workflow-pack-init.ts`
- Modify: `package.json` (add `workflow-pack/` to `files:`)
- Test: `tests/workflow-pack-init.test.ts`

**Interfaces:**
- Consumes: the shipped template (resolved relative to the package root). `validateManifest` (T1) shape for the stub.
- Produces: `scaffoldPack({ name, targetDir, templateRoot?, fs? }): { dir: string }`. Copies static files (manifest.json, entry.js, agents/, README.md, .gitignore); creates empty `inputs/ outputs/ intermediate/ runs/` + `.gitkeep`. Default `targetDir = <cwd>/.pi/workflows/<name>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/workflow-pack-init.test.ts
import { scaffoldPack } from "../src/workflow-pack-init.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("scaffoldPack copies static files and creates empty ephemeral dirs with .gitkeep", () => {
  const root = mkdtempSync(join(tmpdir(), "init-"));
  const templateRoot = join(process.cwd(), "workflow-pack", "template");
  const dir = scaffoldPack({ name: "demo", targetDir: join(root, "demo"), templateRoot });
  expect(existsSync(join(dir.dir, "manifest.json"))).toBe(true);
  expect(existsSync(join(dir.dir, "entry.js"))).toBe(true);
  expect(existsSync(join(dir.dir, "agents"))).toBe(true);
  expect(existsSync(join(dir.dir, "README.md"))).toBe(true);
  expect(existsSync(join(dir.dir, ".gitignore"))).toBe(true);
  for (const d of ["inputs", "outputs", "intermediate", "runs"]) {
    expect(existsSync(join(dir.dir, d, ".gitkeep"))).toBe(true);
  }
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-init.test.ts )`
Expected: FAIL — module + template dir not found.

- [ ] **Step 3: Write minimal implementation** — first create the template files:

`workflow-pack/template/manifest.json`:
```json
{
  "name": "REPLACE_ME",
  "description": "A self-contained workflow pack.",
  "entry": "entry.js",
  "kind": "workflow-pack",
  "agents": "agents/*.md"
}
```

`workflow-pack/template/entry.js`:
```js
export const meta = { name: "REPLACE_ME", description: "A self-contained workflow pack.", phases: [{ title: "Run" }] };
export default async function ({ agent, args, log }) {
  const out = await agent("Do the task.", { agentType: "worker" });
  log(out);
  return out;
}
```

`workflow-pack/template/agents/worker.md`:
```md
---
name: worker
description: The pack's default worker role.
tools: Read, Write, Bash
---
You are a focused worker. Do exactly the task you are given.
```

`workflow-pack/template/README.md`:
```md
# REPLACE_ME

A self-contained workflow pack. Edit `manifest.json` + `entry.js` + `agents/`.
Runtime state (`outputs/ intermediate/ runs/`) is gitignored and purgeable via `workflow pack clean`.
Checked-in packs (under `bun-apps/<pkg>/workflows/`) auto-redirect state to `.pi/workflows/.state/<packId>/`.
```

`workflow-pack/template/.gitignore`:
```
outputs/
intermediate/
runs/
```

Then `src/workflow-pack-init.ts`:
```ts
/**
 * workflow-pack-init.ts — `workflow pack init <name>` scaffolder (07).
 * Copies the shipped template's static files + creates empty ephemeral dirs.
 * Targets <cwd>/.pi/workflows/<name>; refuses a package dir (checked-in packs
 * are authored manually). Pure over an injectable fs (defaults to node:fs).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATIC = ["manifest.json", "entry.js", "README.md", ".gitignore"];
const EPHEMERAL = ["inputs", "outputs", "intermediate", "runs"];

export function scaffoldPack(args: {
  name: string;
  targetDir: string;
  templateRoot: string;
}): { dir: string } {
  mkdirSync(args.targetDir, { recursive: true });
  for (const f of STATIC) {
    const src = join(args.templateRoot, f);
    if (existsSync(src)) copyFileSync(src, join(args.targetDir, f));
  }
  // agents/ dir copied wholesale
  const agentsSrc = join(args.templateRoot, "agents");
  if (existsSync(agentsSrc)) {
    const dst = join(args.targetDir, "agents");
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(agentsSrc)) copyFileSync(join(agentsSrc, f), join(dst, f));
  } else {
    mkdirSync(join(args.targetDir, "agents"), { recursive: true });
  }
  for (const d of EPHEMERAL) {
    mkdirSync(join(args.targetDir, d), { recursive: true });
    writeFileSync(join(args.targetDir, d, ".gitkeep"), "");
  }
  return { dir: args.targetDir };
}
```

Add to `package.json` `files:` array: `"workflow-pack/"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack-init.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/workflow-pack/ bun-apps/pi-agent-ext-workflow/src/workflow-pack-init.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack-init.test.ts bun-apps/pi-agent-ext-workflow/package.json
git commit -m "feat(workflow-pack): scaffolder + shipped template + files: (ticket 14, T7)"
```

---

### Task 8: Reference pack (exercises manifest/agents/state/clean)

**Files:**
- Create: `samples/reference-pack/manifest.json`, `samples/reference-pack/entry.js`, `samples/reference-pack/agents/researcher.md`, `samples/reference-pack/agents/writer.md`, `samples/reference-pack/.gitignore`
- Test: `tests/reference-pack.test.ts`

**Interfaces:**
- Consumes: T1 (manifest io/agents), T3 (bundled agents), T4 (pack-state), T5 (clean), T7 (template shape).

- [ ] **Step 1: Write the failing test**

```ts
// tests/reference-pack.test.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../src/workflow-pack-manifest.js";
import { loadAgentRegistry } from "../src/agent-registry.js";
import { inspectPack, cleanPack } from "../src/workflow-pack-clean.js";

const PACK = join(process.cwd(), "samples", "reference-pack");

test("reference pack has a valid manifest exercising io + agents + version", () => {
  const m = validateManifest(JSON.parse(readFileSync(join(PACK, "manifest.json"), "utf8")));
  expect(m.agents).toBe("agents/*.md");
  expect(m.io?.outputs?.naming).toBe("timestamped");
  expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("reference pack bundles >=2 agent roles that load + bind", () => {
  const reg = loadAgentRegistry(process.cwd(), { projectDir: join(PACK, "agents") });
  // project-dir scan treats the pack agents as project defs here (binding proof)
  expect(reg.has("researcher")).toBe(true);
  expect(reg.has("writer")).toBe(true);
});

test("reference pack ships a .gitignore for ephemeral dirs", () => {
  const gi = readFileSync(join(PACK, ".gitignore"), "utf8");
  expect(gi).toContain("outputs/");
  expect(gi).toContain("intermediate/");
  expect(gi).toContain("runs/");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/reference-pack.test.ts )`
Expected: FAIL — `samples/reference-pack` not found.

- [ ] **Step 3: Write minimal implementation** — create the reference pack:

`samples/reference-pack/manifest.json`:
```json
{
  "name": "reference-pack",
  "description": "Living reference pack exercising the self-contained workflow-pack model.",
  "entry": "entry.js",
  "kind": "workflow-pack",
  "version": "0.1.0",
  "agents": "agents/*.md",
  "io": {
    "outputs": { "naming": "timestamped", "retention": "all" },
    "intermediate": { "persist": false, "retention": "all" },
    "runs": { "retention": "all" }
  }
}
```

`samples/reference-pack/entry.js`:
```js
export const meta = { name: "reference-pack", description: "Exercises manifest + bundled agents.", phases: [{ title: "Research" }, { title: "Write" }] };
export default async function ({ agent, log }) {
  const research = await agent("Research the topic.", { agentType: "researcher" });
  log(research);
  const draft = await agent("Write up the findings.", { agentType: "writer" });
  return draft;
}
```

`samples/reference-pack/agents/researcher.md`:
```md
---
name: researcher
description: Gathers facts for the reference pack.
tools: Read, Grep, WebSearch
---
You research thoroughly and report concise findings.
```

`samples/reference-pack/agents/writer.md`:
```md
---
name: writer
description: Drafts the reference pack's output.
tools: Read, Write
---
You write clear, well-structured prose from given findings.
```

`samples/reference-pack/.gitignore`:
```
outputs/
intermediate/
runs/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/reference-pack.test.ts )`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/samples/reference-pack/ bun-apps/pi-agent-ext-workflow/tests/reference-pack.test.ts
git commit -m "feat(workflow-pack): reference pack exercising manifest/agents/io (ticket 14, T8)"
```

---

## Final whole-branch gate (after all tasks)

- [ ] **Build:** `( cd bun-apps/pi-agent-ext-workflow && bun run build )` — `bunx tsc` clean.
- [ ] **Lint:** `( cd bun-apps/pi-agent-ext-workflow && biome check . )` — clean.
- [ ] **Full suite:** `( cd bun-apps/pi-agent-ext-workflow && bun test )` — all green, incl. existing inline/resume tests UNCHANGED (13 zero-regression proof).
- [ ] **Published-surface check:** confirm `workflow-pack/` lands in `dist`-adjacent published files (the `files:` entry).
- [ ] **Dispatch the final code reviewer** (most capable model) on the whole branch via `superpowers:requesting-code-review`.

## Out of 14 scope (follow-on tickets)

- **On-disk intermediate mirror (12)** + **repeat-run `outputs/<ts>/` + input-hash tag (11)**: these hook the RUNNER (`workflow.ts` agent()-result journaling), which is a separate integration surface from 14's independently-testable units. Land as follow-on tickets once T1–T8 are in, so the runner hooks build on a stable manifest/state foundation.
- **Clean/inspect CLI wiring** (06) + **`init` CLI command** (07) + **pack-run navigator scoping** (13): the pure units land in T5/T7; wiring them into `builtin-commands.ts`/the TUI is follow-on.
