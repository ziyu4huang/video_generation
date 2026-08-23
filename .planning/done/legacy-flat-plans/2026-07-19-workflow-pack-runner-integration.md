# Workflow-Pack Runner Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire pack-local runtime state, on-disk intermediate mirroring (decision 12), and repeat-run `outputs/<ts>/` (decision 11) into the workflow runner so a workflow-pack is a self-contained, repeatable, inspectable unit **at runtime** — completing the runtime half of the self-containment destination whose foundational primitives landed in PR #689 (ADR-0001 / ADR-0002 / T1–T8).

**Architecture:** Pack identity + state root are resolved ONCE in the tool layer (`workflow-tool.ts`, where `resolveWorkflowPack` already yields `packDir` + `manifest`) and passed DOWN as explicit `ExecOptions` fields to `WorkflowManager.executeRun`. The manager uses a **run-scoped persistence** (`createRunPersistence(cwd, undefined, stateRoot)`) cached per state-root, so inline `script:` runs keep the legacy cwd store byte-identical (backward-compat, decision 13) while each pack redirects to `<repoRoot>/.pi/workflows/.state/<packId>/` (decision 03 / ADR-0001) — or stays in-place under `.pi/workflows/<name>/`. The existing in-JSON `journal` array stays the resume source-of-truth (decision 12); the on-disk `intermediate/` mirror is a **disposable, opt-in** (`io.intermediate.persist: true`) side-write emitted from the existing `onAgentJournal` hook. At run end, the final result + an input content-hash tag append to `outputs/<ts>/` (decision 11). The engine (`runWorkflow`) gains only a `phase?` field on `JournalEntry`; **all pack logic stays in the manager + helpers** — the engine never imports pack concepts.

**Tech Stack:** TypeScript, Bun, `node:crypto`, `node:fs`, `node:path`. Tests via `bun test`. Package: `bun-apps/pi-agent-ext-workflow`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Tests: `( cd bun-apps/pi-agent-ext-workflow && bun test )`. Typecheck: `bunx tsc`.
- **Backward-compat (decision 13)** — an inline `script:` run (no `packId`) MUST be byte-identical to today: same `createRunPersistence(cwd)` store, same journal, NO intermediate mirror, NO `outputs/<ts>/`. Pack-wins only when `packId` is set. Every task's tests include an inline-run regression case.
- **Never `~/.pi`** for pack state (decision 03 / ADR-0001) — pack state redirects to `<repoRoot>/.pi/workflows/.state/<packId>/` or is in-place under `.pi/workflows/<name>/`.
- **Journal is canonical** (decision 12) — the on-disk `intermediate/` mirror is disposable; purging or failing to write it NEVER affects resume or the run result. `mirrorIntermediate` is best-effort (swallows errors).
- **`.pi` is NOT gitignored in this repo** — pack templates already ship `.gitignore` for `outputs/ intermediate/ runs/` (PR #689). The sample's state dirs are gitignored too.
- Pre-existing `biome check .` dirtiness (~19 errors in untouched files) is OUT OF SCOPE — do not "fix" unrelated lint.
- Each task ends green: `bunx tsc` clean + the task's tests pass + one focused commit.

## File Structure

**Create:**
- `src/pack-run-context.ts` — pure helpers: `resolvePackRunContext()` (pack identity → state-root + io dirs) and `mirrorIntermediate()` (journal entry → disposable on-disk file). Single responsibility: "pack-run filesystem context." No runner/engine imports.
- `tests/pack-run-context.test.ts` — unit tests for both helpers.

**Modify:**
- `src/run-persistence.ts` — `createRunPersistence(cwd, fsOverride?, stateRoot?)`: optional 3rd arg redirects `runsDir` to `<stateRoot>/runs`.
- `src/workflow.ts` — `JournalEntry` gains `phase?: string`; emit it at the two `onAgentJournal` call sites (agent success ~L530 + checkpoint ~L905).
- `src/workflow-manager.ts` — `ExecOptions` gains `packId?` / `stateRoot?` / `intermediateDir?` / `outputsDir?` / `io?`; a run-scoped persistence cache; `ManagedRun` gains `packId?` / `stateRoot?`; `onAgentJournal` mirrors when opted-in; run-end writes `outputs/<ts>/`.
- `src/workflow-tool.ts` — when `params.name` resolves a pack, compute `resolvePackRunContext` and pass its fields into `startInBackground` / `runSync` `ExecOptions`.
- `tests/run-persistence.test.ts` — add `stateRoot` cases.
- `tests/workflow-manager-pack.test.ts` (new) — pack-run persistence routing + intermediate mirror + `outputs/<ts>/` integration (mock agent).
- `samples/reference-pack/manifest.json` — add an `io` block exercising the mirror.
- `tests/reference-pack.test.ts` — assert `io` parse round-trips (mirror behavior covered by the manager test).

---

### Task 1: `createRunPersistence` accepts optional `stateRoot`

**Files:**
- Modify: `src/run-persistence.ts`
- Test: `tests/run-persistence.test.ts`

**Interfaces:**
- Produces: `createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>, stateRoot?: string): RunPersistence`. When `stateRoot` is set, `getRunsDir()` returns `join(stateRoot, "runs")` and `save()` writes there. When absent → existing `workflowProjectPaths(cwd).runsDir` (unchanged).

- [ ] **Step 1: Write the failing tests** (append to `tests/run-persistence.test.ts`)

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createRunPersistence } from "../src/run-persistence.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

test("createRunPersistence redirects runsDir to <stateRoot>/runs when stateRoot is given", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "pr-state-"));
  const stateRoot = join(tmp, "pack-state");
  const p = createRunPersistence(tmp, undefined, stateRoot);
  expect(p.getRunsDir()).toBe(join(stateRoot, "runs"));
});

test("createRunPersistence uses cwd project runs when stateRoot is absent (backward-compat)", () => {
  const p = createRunPersistence("/some/cwd");
  expect(p.getRunsDir()).toBe(workflowProjectPaths("/some/cwd").runsDir);
});

test("a stateRoot-routed persistence writes its run file under <stateRoot>/runs", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "pr-state-"));
  const stateRoot = join(tmp, "pack-state");
  const p = createRunPersistence(tmp, undefined, stateRoot);
  p.save({
    runId: "r1", workflowName: "w", script: "x", status: "running",
    phases: [], agents: [], logs: [], startedAt: "t", updatedAt: "t",
  });
  expect(p.load("r1")?.runId).toBe("r1");
  expect(p.getRunsDir()).toContain("pack-state");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/run-persistence.test.ts )`
Expected: FAIL — `getRunsDir()` returns the cwd path, not `<stateRoot>/runs` (3rd arg ignored).

- [ ] **Step 3: Implement** — in `src/run-persistence.ts`, change the signature + `runsDir` resolution inside `createRunPersistence`. The current body starts with `const paths = workflowProjectPaths(cwd); const runsDir = paths.runsDir; const legacyRunsDir = paths.legacyRunsDir;`. Replace the `runsDir` line:

```ts
export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  stateRoot?: string,
): RunPersistence {
  // …existing _existsSync / _mkdirSync / … assignments unchanged…

  const paths = workflowProjectPaths(cwd);
  const runsDir = stateRoot ? join(stateRoot, "runs") : paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;
  // …rest unchanged…
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/run-persistence.test.ts )`
Expected: PASS (new + existing). Then `bunx tsc` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/run-persistence.ts tests/run-persistence.test.ts
git commit -m "feat(workflow-pack): createRunPersistence accepts optional stateRoot (T1)"
```

---

### Task 2: `resolvePackRunContext` helper (pure)

**Files:**
- Create: `src/pack-run-context.ts`
- Test: `tests/pack-run-context.test.ts`

**Interfaces:**
- Consumes: `packStateRoot` + `ensureStateDirs` (src/pack-state.ts, PR #689), `packId` (src/workflow-pack-id.ts, PR #689), `Manifest`/`ManifestIo` (src/workflow-pack-manifest.ts, PR #689).
- Produces: `resolvePackRunContext({ name, packDir, manifest?, repoRoot }): PackRunContext` where `PackRunContext = { packId, stateRoot, redirected, runsDir, outputsDir, intermediateDir, io? }`.

- [ ] **Step 1: Write the failing tests** (`tests/pack-run-context.test.ts`)

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { resolvePackRunContext } from "../src/pack-run-context.js";
import { packId } from "../src/workflow-pack-id.js";

test("in-place pack (.pi/workflows/<name>) → redirected=false, stateRoot=packDir", () => {
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, ".pi", "workflows", "demo");
  const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
  expect(ctx.redirected).toBe(false);
  expect(ctx.stateRoot).toBe(packDir);
  expect(ctx.runsDir).toBe(join(packDir, "runs"));
  expect(ctx.outputsDir).toBe(join(packDir, "outputs"));
  expect(ctx.intermediateDir).toBe(join(packDir, "intermediate"));
  expect(ctx.packId).toBe(packId("demo", packDir));
});

test("checked-in pack (outside .pi/workflows) → redirected=true, stateRoot=<repo>/.pi/workflows/.state/<packId>", () => {
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, "bun-apps", "some-pkg", "workflows", "demo");
  const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
  expect(ctx.redirected).toBe(true);
  expect(ctx.stateRoot).toBe(join(repo, ".pi", "workflows", ".state", ctx.packId));
});

test("manifest.io flows through to ctx.io", () => {
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, ".pi", "workflows", "demo");
  const ctx = resolvePackRunContext({
    name: "demo", packDir, repoRoot: repo,
    manifest: { name: "demo", description: "d", io: { intermediate: { persist: true } } } as any,
  });
  expect(ctx.io?.intermediate?.persist).toBe(true);
});

test("resolvePackRunContext creates runs/outputs/intermediate under stateRoot", () => {
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, "bun-apps", "pkg", "workflows", "demo");
  const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
  const { existsSync } = require("node:fs");
  expect(existsSync(join(ctx.stateRoot, "runs"))).toBe(true);
  expect(existsSync(join(ctx.stateRoot, "outputs"))).toBe(true);
  expect(existsSync(join(ctx.stateRoot, "intermediate"))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-run-context.test.ts )`
Expected: FAIL — module `../src/pack-run-context.js` not found.

- [ ] **Step 3: Implement** (`src/pack-run-context.ts`)

```ts
/**
 * pack-run-context.ts — resolve a pack's runtime filesystem context (decisions 03/07/12).
 *
 * Pure packaging over the PR-#689 primitives (packStateRoot / ensureStateDirs / packId):
 * given a pack's identity (name + packDir + optional manifest) and the repo root, derive
 * the single state root + its runs/outputs/intermediate dirs + the manifest io contract.
 * The tool layer calls this once per pack run and passes the result DOWN to the manager
 * as ExecOptions — the engine (runWorkflow) never imports pack concepts.
 */
import { join } from "node:path";
import { packId } from "./workflow-pack-id.js";
import { packStateRoot, ensureStateDirs } from "./pack-state.js";
import type { Manifest, ManifestIo } from "./workflow-pack-manifest.js";

export interface PackRunContext {
  packId: string;
  stateRoot: string;
  redirected: boolean;
  runsDir: string;
  outputsDir: string;
  intermediateDir: string;
  io?: ManifestIo;
}

export function resolvePackRunContext(args: {
  name: string;
  packDir: string;
  manifest?: Manifest;
  repoRoot: string;
}): PackRunContext {
  const { root, redirected } = packStateRoot({
    packDir: args.packDir,
    name: args.name,
    repoRoot: args.repoRoot,
  });
  ensureStateDirs(root);
  return {
    packId: packId(args.name, args.packDir),
    stateRoot: root,
    redirected,
    runsDir: join(root, "runs"),
    outputsDir: join(root, "outputs"),
    intermediateDir: join(root, "intermediate"),
    io: args.manifest?.io,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-run-context.test.ts )` → PASS. `bunx tsc` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/pack-run-context.ts tests/pack-run-context.test.ts
git commit -m "feat(workflow-pack): resolvePackRunContext helper (T2)"
```

---

### Task 3: `mirrorIntermediate` helper (pure, best-effort)

**Files:**
- Modify: `src/pack-run-context.ts` (append helper + export)
- Test: `tests/pack-run-context.test.ts` (append)

**Interfaces:**
- Produces: `mirrorIntermediate(intermediateDir: string, phase: string | undefined, entry: { index: number; hash: string; result: unknown }): void`. Writes `<intermediateDir>/<phase|"_no-phase">/<index>-<hash>.<ext>` where `ext` = `txt` for a string result, else `json`. Idempotent (same name overwrites). **Never throws** (best-effort; decision 12: the mirror is disposable).

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { mirrorIntermediate } from "../src/pack-run-context.js";

test("mirrorIntermediate writes <phase>/<idx>-<hash>.json for an object result", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "mirror-"));
  mirrorIntermediate(tmp, "research", { index: 3, hash: "abc123", result: { finding: "x" } });
  const file = join(tmp, "research", "3-abc123.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ finding: "x" });
});

test("mirrorIntermediate writes .txt for a string result", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "mirror-"));
  mirrorIntermediate(tmp, "draft", { index: 1, hash: "h", result: "hello world" });
  expect(readFileSync(join(tmp, "draft", "1-h.txt"), "utf-8")).toBe("hello world");
});

test("mirrorIntermediate uses _no-phase when phase is undefined", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "mirror-"));
  mirrorIntermediate(tmp, undefined, { index: 0, hash: "z", result: 42 });
  expect(existsSync(join(tmp, "_no-phase", "0-z.json"))).toBe(true);
});

test("mirrorIntermediate is idempotent (same name overwrites)", () => {
  const tmp = mkdtempSync(join(os.tmpdir(), "mirror-"));
  mirrorIntermediate(tmp, "p", { index: 1, hash: "h", result: "v1" });
  mirrorIntermediate(tmp, "p", { index: 1, hash: "h", result: "v2" });
  expect(readFileSync(join(tmp, "p", "1-h.txt"), "utf-8")).toBe("v2");
});

test("mirrorIntermediate never throws on a bad path", () => {
  expect(() => mirrorIntermediate("/proc/cannot/write/here", "p", { index: 0, hash: "h", result: "x" })).not.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-run-context.test.ts )`
Expected: FAIL — `mirrorIntermediate` is not exported.

- [ ] **Step 3: Implement** — append to `src/pack-run-context.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Mirror one journal entry to the disposable on-disk intermediate tree (decision 12).
 * Layout: <intermediateDir>/<phase|_no-phase>/<index>-<hash>.<ext>. The journal stays
 * the resume source-of-truth; this file is purely for agent inspection and is safe to
 * purge at any time. Best-effort: a write failure is swallowed so it can never break a run.
 */
export function mirrorIntermediate(
  intermediateDir: string,
  phase: string | undefined,
  entry: { index: number; hash: string; result: unknown },
): void {
  try {
    const phaseDir = join(intermediateDir, phase || "_no-phase");
    mkdirSync(phaseDir, { recursive: true });
    const isText = typeof entry.result === "string";
    const ext = isText ? "txt" : "json";
    const content = isText ? String(entry.result) : JSON.stringify(entry.result, null, 2);
    writeFileSync(join(phaseDir, `${entry.index}-${entry.hash}.${ext}`), content);
  } catch {
    // Disposable mirror (decision 12): never let a side-write break the run.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/pack-run-context.test.ts )` → PASS. `bunx tsc` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/pack-run-context.ts tests/pack-run-context.test.ts
git commit -m "feat(workflow-pack): mirrorIntermediate disposable side-write (T3)"
```

---

### Task 4: `JournalEntry.phase` + emit sites

**Files:**
- Modify: `src/workflow.ts` (interface + 2 emit sites)
- Test: `tests/workflow-manager-pack.test.ts` (the phase assertion; full harness built in T5–T6, but add the focused assertion here via a tiny mock run)

**Interfaces:**
- Produces: `JournalEntry` gains `phase?: string`. The `onAgentJournal` callback at the agent-success site (~L530) and the checkpoint site (~L905) include `phase`.

- [ ] **Step 1: Write the failing test** (`tests/workflow-manager-pack.test.ts`, create file)

```ts
import { test } from "bun:test";
import { runWorkflow } from "../src/workflow.js";

/** A mock agent that returns a canned string without any provider call. */
const mockAgent = { run: async (_prompt: string) => "mocked" };

test("onAgentJournal entries carry the assigned phase (T4)", async () => {
  const seen: Array<{ index: number; phase?: string }> = [];
  const script = `
    export const meta = { name: "t4", description: "phase emit" };
    export default async ({ agent, phase }) => {
      phase("research");
      await agent("do research");
    };
  `;
  await runWorkflow(script, { agent: mockAgent as any, onAgentJournal: (e) => seen.push({ index: e.index, phase: e.phase }) });
  expect(seen.length).toBe(1);
  expect(seen[0].phase).toBe("research");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )`
Expected: FAIL — `entry.phase` is `undefined`.

- [ ] **Step 3: Implement** — in `src/workflow.ts`:

(a) Extend the interface (~L39):
```ts
export interface JournalEntry {
  index: number;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /** The phase the agent ran under, for the disposable intermediate mirror (decision 12). */
  phase?: string;
}
```

(b) At the agent-success emit (~L530, inside `agent()`'s success path), add `phase`:
```ts
options.onAgentJournal?.({ index: callIndex, hash: callHash, result, phase: assignedPhase });
```

(c) At the checkpoint emit (~L905), add `phase`:
```ts
options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply, phase: state.currentPhase });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )` → PASS. `bunx tsc` — clean. Re-run the full suite to confirm no existing journal consumer broke: `bun test` (expect only the known-flaky `usage-limit-integration` timeout; all else green).

- [ ] **Step 5: Commit**

```bash
git add src/workflow.ts tests/workflow-manager-pack.test.ts
git commit -m "feat(workflow-pack): JournalEntry.phase emitted at agent + checkpoint (T4)"
```

---

### Task 5: `WorkflowManager` run-scoped persistence + `ExecOptions` pack fields

**Files:**
- Modify: `src/workflow-manager.ts`
- Test: `tests/workflow-manager-pack.test.ts` (append)

**Interfaces:**
- Consumes: `createRunPersistence(cwd, fsOverride?, stateRoot?)` (T1).
- Produces: `ExecOptions` gains `{ packId?: string; stateRoot?: string; intermediateDir?: string; outputsDir?: string; io?: ManifestIo }`. `ManagedRun` gains `packId?: string` + `stateRoot?: string`. A private `persistenceFor(stateRoot?)` returns a cached `RunPersistence` (cwd store for inline, a stateRoot store per pack). `executeRun` routes lease/save/delete through it + stamps `packId` onto the persisted state.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { WorkflowManager } from "../src/workflow-manager.js";
import { createRunPersistence } from "../src/run-persistence.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";

const mockAgent = { run: async (_p: string) => "ok" };

test("a pack run (stateRoot set) persists its run file under <stateRoot>/runs, not the cwd store", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    {},
    { stateRoot, packId: "demo-abc123" },
  );
  // give the background run a tick to persist
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(join(stateRoot, "runs", `${runId}.json`))).toBe(true);
  // the cwd store must NOT contain it
  const cwdStore = createRunPersistence(cwd);
  expect(cwdStore.load(runId)).toBeNull();
});

test("an inline run (no stateRoot) still persists to the cwd store (backward-compat)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    {},
    {},
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(createRunPersistence(cwd).load(runId)?.runId).toBe(runId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )`
Expected: FAIL — pack run lands in the cwd store (stateRoot ignored); backward-compat test passes already.

- [ ] **Step 3: Implement** — in `src/workflow-manager.ts`:

(a) Add pack fields to `ExecOptions` (after `confirm?`):
```ts
/** Pack identity (decision 08); absent for inline scripts. Presence routes state to stateRoot. */
packId?: string;
/** Pack-local state root; when set, this run's persistence writes to <stateRoot>/runs. */
stateRoot?: string;
/** Pack intermediate dir; onAgentJournal mirrors here when io.intermediate.persist. */
intermediateDir?: string;
/** Pack outputs dir; run end appends <outputsDir>/<ts>/. */
outputsDir?: string;
/** Pack io contract (decision 05). */
io?: ManifestIo;
```
(Add `import type { ManifestIo } from "./workflow-pack-manifest.js";` at top.)

(b) Add `packId?` + `stateRoot?` to the `ManagedRun` interface.

(c) Add a persistence cache + helper near the `persistence` field:
```ts
private persistences = new Map<string, RunPersistence>();

/** Resolve the persistence for a run: a cached stateRoot store for packs, else the cwd store. */
private persistenceFor(stateRoot?: string): RunPersistence {
  if (!stateRoot) return this.persistence;
  let p = this.persistences.get(stateRoot);
  if (!p) {
    p = createRunPersistence(this.cwd, undefined, stateRoot);
    this.persistences.set(stateRoot, p);
  }
  return p;
}
```

(d) In `startInBackground` / `runSync` / `executeRun`, thread `exec.stateRoot` / `exec.packId` onto the `ManagedRun`, and replace `this.persistence` usages within `executeRun`'s per-run lease/save/delete with `this.persistenceFor(managed.stateRoot)`. Specifically: `acquireRunLease`, the `save({...})` calls inside `executeRun`, and the final `releaseRunLease` should use the run-scoped persistence. (`recoverStaleRuns` + `listAllRuns` keep using `this.persistence` — navigator aggregation across packs is Plan C.) Stamp `packId: managed.packId` into the saved `PersistedRunState` (it already has the field from PR #689 T6).

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )` → both PASS. `bunx tsc` — clean. Full suite `bun test` still green (modulo the known flake).

- [ ] **Step 5: Commit**

```bash
git add src/workflow-manager.ts tests/workflow-manager-pack.test.ts
git commit -m "feat(workflow-pack): run-scoped persistence + ExecOptions pack fields (T5)"
```

---

### Task 6: intermediate mirror + `outputs/<ts>/` in `executeRun`

**Files:**
- Modify: `src/workflow-manager.ts`
- Test: `tests/workflow-manager-pack.test.ts` (append)

**Interfaces:**
- Consumes: `mirrorIntermediate` (T3), `JournalEntry` (now with `phase`, T4).
- Produces: (a) the `onAgentJournal` hook inside `executeRun` calls `mirrorIntermediate(exec.intermediateDir, entry.phase, entry)` when `exec.io?.intermediate?.persist` is true; (b) on successful run completion, if `exec.outputsDir` is set, writes `<outputsDir>/<ts>/result.json` + `<outputsDir>/<ts>/run-meta.json` (run-meta includes an input content-hash of `args`).

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { readdirSync, readFileSync } from "node:fs";

test("onAgentJournal mirrors to intermediate/ when io.intermediate.persist is true", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent,phase})=>{phase("research");await agent("x");};`,
    {},
    { stateRoot, packId: "demo-x", intermediateDir: join(stateRoot,"intermediate"), io: { intermediate: { persist: true } } },
  );
  await new Promise((r) => setTimeout(r, 80));
  const researchDir = join(stateRoot, "intermediate", "research");
  expect(existsSync(researchDir)).toBe(true);
  expect(readdirSync(researchDir).some((f) => f.endsWith(".json"))).toBe(true);
});

test("intermediate mirror is NOT written when io.intermediate.persist is absent (default off)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    {},
    { stateRoot, packId: "demo-y", intermediateDir: join(stateRoot,"intermediate"), io: {} },
  );
  await new Promise((r) => setTimeout(r, 80));
  expect(readdirSync(join(stateRoot, "intermediate")).length).toBe(0);
});

test("run end appends outputs/<ts>/result.json + run-meta.json (decision 11)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const outputsDir = join(stateRoot, "outputs");
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  await mgr.runSync(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    { topic: "cats" },
    { stateRoot, packId: "demo-z", outputsDir },
  );
  const tsDirs = readdirSync(outputsDir);
  expect(tsDirs.length).toBe(1);
  const runDir = join(outputsDir, tsDirs[0]);
  expect(existsSync(join(runDir, "result.json"))).toBe(true);
  const meta = JSON.parse(readFileSync(join(runDir, "run-meta.json"), "utf-8"));
  expect(meta.inputHash).toMatch(/^[0-9a-f]{12}$/);
  expect(meta.packId).toBe("demo-z");
});

test("a repeat run appends a NEW <ts> subdir (no overwrite, decision 11)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const outputsDir = join(stateRoot, "outputs");
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const script = `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`;
  for (let i = 0; i < 2; i++) {
    await mgr.runSync(script, { topic: "cats" }, { stateRoot, packId: "demo-r", outputsDir });
  }
  expect(readdirSync(outputsDir).length).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )`
Expected: FAIL — no intermediate files; no `outputs/<ts>/`.

- [ ] **Step 3: Implement** — in `src/workflow-manager.ts` `executeRun`:

(a) Extend the existing `onAgentJournal` callback (currently ~L337) to also mirror:
```ts
onAgentJournal: (entry) => {
  managed.journal = managed.journal.filter((e) => e.index !== entry.index);
  managed.journal.push(entry);
  if (exec.io?.intermediate?.persist && exec.intermediateDir) {
    mirrorIntermediate(exec.intermediateDir, entry.phase, entry); // disposable side-write (decision 12)
  }
  this.persistRun(managed);
},
```
(Add `import { mirrorIntermediate } from "./pack-run-context.js";` at top.)

(b) Add a small input-hash helper (module-private, near the top of the file):
```ts
import { createHash } from "node:crypto";
function inputHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 12);
}
function compactTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-"); // filesystem-safe, sortable
}
```

(c) After `runWorkflow` resolves successfully (the success branch of `executeRun`, before the final `persistRun`), append the run outputs when `exec.outputsDir` is set:
```ts
if (exec.outputsDir) {
  try {
    const ts = compactTimestamp();
    const runOut = join(exec.outputsDir, ts);
    mkdirSync(runOut, { recursive: true });
    writeFileSync(join(runOut, "result.json"), JSON.stringify(receipt.result ?? null, null, 2));
    writeFileSync(
      join(runOut, "run-meta.json"),
      JSON.stringify(
        { runId: managed.runId, packId: managed.packId, inputHash: inputHash(args), startedAt, finishedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch {
    // outputs/<ts>/ is an inspection aid, not a correctness gate; never fail the run.
  }
}
```
(Add `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";` if not already present. `receipt` is the `runWorkflow` return; `args` is the run's merged args; `startedAt` is the run start timestamp already tracked.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )` → all PASS. `bunx tsc` — clean. Full suite green (modulo known flake).

- [ ] **Step 5: Commit**

```bash
git add src/workflow-manager.ts tests/workflow-manager-pack.test.ts
git commit -m "feat(workflow-pack): intermediate mirror + outputs/<ts>/ append (T6, decisions 11/12)"
```

---

### Task 7: wire `workflow-tool.ts` to pass pack context

**Files:**
- Modify: `src/workflow-tool.ts`
- Test: `tests/workflow-manager-pack.test.ts` (append a wiring test)

**Interfaces:**
- Consumes: `resolveWorkflowPack` (already imported), `findRepoRoot` (from workflow-pack.ts), `resolvePackRunContext` (T2).
- Produces: when `params.name` resolves a pack, the `ExecOptions` passed to `manager.startInBackground` / `manager.runSync` include `{ packId, stateRoot, intermediateDir, outputsDir, io }` from `resolvePackRunContext`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { resolvePackRunContext } from "../src/pack-run-context.js";

test("workflow-tool passes pack context into ExecOptions when a pack is named (T7 wiring)", () => {
  // Unit-level: resolvePackRunContext is the single source of truth the tool uses.
  // Assert the shape the tool will spread into ExecOptions matches the manager's expectation.
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, ".pi", "workflows", "wired");
  const ctx = resolvePackRunContext({ name: "wired", packDir, repoRoot: repo });
  // The 5 fields the tool spreads into ExecOptions:
  const execFields = (({ packId, stateRoot, intermediateDir, outputsDir, io }) => ({
    packId, stateRoot, intermediateDir, outputsDir, io,
  }))(ctx);
  expect(execFields.packId).toBeDefined();
  expect(execFields.stateRoot).toBe(packDir);
  expect(execFields.intermediateDir).toBe(join(packDir, "intermediate"));
  expect(execFields.outputsDir).toBe(join(packDir, "outputs"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )`
Expected: FAIL only if `resolvePackRunContext` is not yet imported in the test (it is from T2) — so this acts as a shape lock. If it passes already, that's acceptable (it pins the contract); proceed to implement the wiring regardless.

- [ ] **Step 3: Implement** — in `src/workflow-tool.ts`, in the `params.name` branch (~L396), after `resolveWorkflowPack`, compute the pack context and spread it into both call sites:

```ts
import { resolveWorkflowPack, mergeArgs, findRepoRoot } from "./workflow-pack.js";
import { resolvePackRunContext } from "./pack-run-context.js";
// …
// after: const resolved = resolveWorkflowPack(params.name, { cwd });
//        script = resolved.script;
//        if (resolved.manifest) mergedArgs = mergeArgs(resolved.manifest.args, params.args);
const packCtx =
  resolved.packDir
    ? resolvePackRunContext({
        name: resolved.manifest?.name ?? params.name,
        packDir: resolved.packDir,
        manifest: resolved.manifest,
        repoRoot: findRepoRoot(resolved.packDir, (p) => existsSync(p)) ?? cwd,
      })
    : undefined;
const packExec = packCtx
  ? { packId: packCtx.packId, stateRoot: packCtx.stateRoot, intermediateDir: packCtx.intermediateDir, outputsDir: packCtx.outputsDir, io: packCtx.io }
  : {};
```
Then spread `...packExec` into the `ExecOptions` of BOTH `manager.startInBackground(script, mergedArgs, { maxAgents, concurrency, agentRetries, agentTimeoutMs, tokenBudget, ...packExec })` and `manager.runSync(script, mergedArgs, { ..., ...packExec })`. (Add `existsSync` to the existing `node:fs` import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager-pack.test.ts )` → PASS. `bunx tsc` — clean. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/workflow-tool.ts tests/workflow-manager-pack.test.ts
git commit -m "feat(workflow-pack): workflow-tool passes pack context into ExecOptions (T7)"
```

---

### Task 8: `reference-pack` exercises `io` + sample assertion

**Files:**
- Modify: `samples/reference-pack/manifest.json`
- Test: `tests/reference-pack.test.ts` (append)

**Interfaces:**
- Produces: the reference pack manifest declares `io.intermediate.persist: true` + `io.outputs.naming: "timestamped"`, so the sample is a faithful end-to-end exerciser of decisions 11/12 once the runner integration ships.

- [ ] **Step 1: Write the failing test** (append to `tests/reference-pack.test.ts`)

```ts
test("reference-pack manifest declares an io block exercising intermediate + outputs (T8)", async () => {
  const { readManifest } = await import("../src/workflow-pack-manifest.js");
  const { resolveWorkflowPack } = await import("../src/workflow-pack.js");
  const resolved = resolveWorkflowPack("reference-pack", { cwd: join(process.cwd(), "samples") });
  const manifest = readManifest(resolved.manifest!); // re-validate through the T1 parser
  expect(manifest.io?.intermediate?.persist).toBe(true);
  expect(manifest.io?.outputs?.naming).toBe("timestamped");
});
```
> If `readManifest` is not the exported name, substitute the actual exported validator from `workflow-pack-manifest.ts` (it is the function `validateManifest` / `parseManifest` that returns a typed `Manifest`). Confirm the exact export name in Step 3 before finalizing.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/reference-pack.test.ts )`
Expected: FAIL — `manifest.io` is `undefined` (the sample has no io block yet).

- [ ] **Step 3: Implement** — edit `samples/reference-pack/manifest.json` to add the `io` block alongside the existing fields (do not remove existing keys):

```json
{
  "name": "reference-pack",
  "description": "Reference workflow pack exercising manifest io, bundled agents, and pack-local state.",
  "version": "0.1.0",
  "io": {
    "outputs": { "naming": "timestamped", "retention": "all" },
    "intermediate": { "persist": true, "retention": "last-N" },
    "runs": { "retention": "all" }
  }
}
```
(Keep any existing `args` / `agents` / `model` keys; only ADD `io`. Confirm the validator's exported name in `src/workflow-pack-manifest.ts` and use it in the test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/reference-pack.test.ts )` → PASS. `bunx tsc` — clean. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add samples/reference-pack/manifest.json tests/reference-pack.test.ts
git commit -m "feat(workflow-pack): reference-pack io block exercises decisions 11/12 (T8)"
```

---

## Self-Review

**1. Spec coverage** (decisions 11, 12, 03/07 wiring, 13 backward-compat):
- **12 on-disk intermediate mirror** (opt-in `io.intermediate.persist`, `<phase>/<idx>-<hash>.<ext>`, disposable, journal-canonical) → T3 (helper) + T4 (phase on entry) + T6 (wired in `onAgentJournal`). ✓
- **11 repeat-run `outputs/<ts>/`** (append, content-hash tag, always-run) → T6 (run-end write + inputHash + new-ts-per-run test). ✓
- **03/07 pack-local state root** (redirect to `.pi/workflows/.state/<packId>/`, never `~/.pi`) → T2 (context) + T5 (run-scoped persistence) + T7 (tool wiring). ✓
- **13 backward-compat** (inline run byte-identical, pack-wins only when packId set) → T5 inline-run regression test + every pack feature gated on `stateRoot`/`io`. ✓
- **05 manifest io** (the `io` block flows end-to-end) → T2 + T7 + T8. ✓

**2. Placeholder scan:** No "TBD"/"implement later". Two intentionally-deferred notes are EXPLICIT scope boundaries, not placeholders: (a) `recoverStaleRuns`/`listAllRuns` keep using the cwd store — cross-pack navigator aggregation is **Plan C**; (b) the foreground `runWorkflowScript` CLI path is **not** wired here (the interactive `workflow` tool via the manager is the primary path; CLI wiring is a follow-on). Both are stated in the Architecture + T5.

**3. Type consistency:** `PackRunContext` fields (`packId`, `stateRoot`, `intermediateDir`, `outputsDir`, `io`) match the `ExecOptions` additions (T5) and the `packExec` spread (T7). `JournalEntry.phase` (T4) is consumed by `mirrorIntermediate(intermediateDir, phase, entry)` (T3/T6). `createRunPersistence(cwd, fsOverride?, stateRoot?)` signature (T1) matches the `persistenceFor` call (T5). `ManifestIo` imported in both `workflow-manager.ts` (T5) and `pack-run-context.ts` (T2).

**4. Risk note (honest):** T5 is the riskiest task — it refactors `executeRun`'s persistence calls from the single `this.persistence` to `persistenceFor(managed.stateRoot)`. If `executeRun` has more `this.persistence` call sites than the lease/save/delete trio, extend the substitution to all of them within `executeRun` (but NOT `recoverStaleRuns`/`listAllRuns`). Run the full `workflow-manager` test suite after T5 to catch any missed site.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-workflow-pack-runner-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
