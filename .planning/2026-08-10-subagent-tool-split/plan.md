# subagent-tool.ts Full Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (1047 lines) into an orchestration-only module plus three focused siblings (`-schema.ts`, `-render.ts`, `-run.ts`), strictly behavior-preserving, collapsing the near-duplicate `persistence.save` / `details` literals behind pure builders.

**Architecture:** Mechanical moves first (schema + render clusters out of the monolith), then a TDD builder module (`-run.ts`) that threads an immutable `RunContext` + mutable `RunProgress` box through a slimmed `execute`. Mirrors the outcome `simplify-recent-code` Phase 2 targets for `workflow.ts`. No public API change.

**Tech Stack:** TypeScript (bundler moduleResolution), TypeBox schemas, `bun test` + `node:assert/strict`, Biome lint/format.

## Global Constraints

- **Behavior-preserving.** No observable change to tool input/output, `details`, persisted run records, or import identities. The 1836-line `tests/subagent-tool.test.ts` is the primary oracle and MUST pass unchanged in Tasks 1–2.
- **Public API stable.** `createSubagentTool`, `subagentToolSchema`, `SubagentToolDetails`, `SubagentToolOptions`, and the `src/index.ts` re-exports (`SubagentToolDetails`, `SubagentToolOptions` types; `createSubagentTool`, `formatHistoryLine` values) keep the SAME exported names — only their source file moves.
- **Per-task gate** (run from repo root, scoped to the package):
  ```
  ( cd bun-apps/pi-agent-ext-subagent && bun run test )
  ```
  This package's `check` script is `biome check .` (lint+format), **not** `tsc`. `bun run test` = `biome check .` && `tsc` (build) && `bun test`, so it covers lint + types + unit tests. Fast feedback loop: `bun run typecheck` (`tsc --noEmit`).
- **Module identity.** The new siblings carry NO singletons. The `inFlight`/`persistence` lazy singletons and the `src/` subpath contract (`CONTEXT.md`) are untouched — only the orchestrator imports them.
- **`import type` discipline.** Type-only imports use `import type`. Runtime imports (`Type`, `shortModel`, `runWatchdog`, `createWorktree`, etc.) stay value imports.
- **Import direction (no cycle):** `schema` (leaf) ← `render` ← `run` ← `subagent-tool` (orchestrator).
  - `schema`: external only (typebox, `./agent`, `./git-scope`, `./sdd-report`, `./spawn-subagent`, `./agent-registry`, `./subagent-in-flight`, `./subagent-run-persistence`, `./watchdog/types`, `./worktree`). No sibling.
  - `render`: `schema` (`SubagentToolDetails`) + external.
  - `run`: `schema` (types) + `render` (`formatSubagentLive`, `deriveSubagentStatus`) + external (`./sdd-report`, `./git-scope`, `./watchdog/*`).
  - `orchestrator`: all three + external.
- **No remote CI.** Verify locally with the gate above; squash-merge via `gh ship` (no `--auto`).
- **Commit scope per task.** One conventional-commit per task; `git add` lists exact files. This effort's files live under `bun-apps/pi-agent-ext-subagent/src/` + `bun-apps/pi-agent-ext-subagent/tests/` only.

---

### Task 1: Create `subagent-tool-schema.ts` — move types + schema + `isSchemaShaped` (2a, mechanical)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (delete L37–241: `SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`, `SubagentToolOptions`, `isSchemaShaped`; add one import line)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:21` (`DEFAULT_TIMEOUT_MS` source)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts:134` (type re-export source)

**Interfaces:**
- Consumes: the verbatim L37–241 block of `subagent-tool.ts` (types + schema + `isSchemaShaped`).
- Produces: `subagent-tool-schema.ts` exporting `SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`, `SubagentToolOptions`, `isSchemaShaped` — same names, same shapes.

- [ ] **Step 1: Create `subagent-tool-schema.ts`.**

Create `src/subagent-tool-schema.ts` with this exact header + the verbatim L37–241 content moved from `subagent-tool.ts`:

```ts
/**
 * Schema, result-details type, and options for the `subagent` tool.
 * Extracted from subagent-tool.ts (behavior-preserving split — no logic change).
 */
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { AgentUsage, BudgetExhaustion } from "./agent.js";
import { type GitScopeOps, type SubagentScopeCheck } from "./git-scope.js";
import { type SddReport } from "./sdd-report.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { SubagentInFlightRegistry } from "./subagent-in-flight.js";
import { type SubagentRunPersistence } from "./subagent-run-persistence.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "./spawn-subagent.js";
import { type WatchdogResult } from "./watchdog/types.js";
import { createWorktree, removeWorktree } from "./worktree.js";

// === MOVE VERBATIM from subagent-tool.ts L37–241 ===
// export interface SubagentToolDetails { ... }
// export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// export const subagentToolSchema = Type.Object({ ... });   // through the end of the schema
// export interface SubagentToolOptions { ... }
// function isSchemaShaped(value: unknown): value is TSchema { ... }
```

Move the five declarations (`SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`, `SubagentToolOptions`, `isSchemaShaped`) verbatim — every field, comment, and JSDoc intact. Keep `isSchemaShaped` non-exported (it is module-local to the schema module now; the orchestrator imports it).

- [ ] **Step 2: Delete L37–241 from `subagent-tool.ts` and re-point its import.**

Remove the five declarations from `subagent-tool.ts`. Add to its import block (top of file):

```ts
import {
  DEFAULT_TIMEOUT_MS,
  isSchemaShaped,
  subagentToolSchema,
  type SubagentToolDetails,
  type SubagentToolOptions,
} from "./subagent-tool-schema.js";
```

The render cluster (still in `subagent-tool.ts` until Task 2) references `SubagentToolDetails` — now resolved via this import. No other edit needed in `subagent-tool.ts` this task.

- [ ] **Step 3: Re-point `subagents-tool.ts` and `index.ts` to the schema module.**

`src/subagents-tool.ts:21` — split the import:
```ts
import { DEFAULT_TIMEOUT_MS } from "./subagent-tool-schema.js";
import { deriveSubagentStatus, taskPreview, workIntentPreview } from "./subagent-tool.js";
```
(`deriveSubagentStatus`/`taskPreview`/`workIntentPreview` stay on `./subagent-tool.js` until Task 2 moves them.)

`src/index.ts:134–135` — re-point the type re-export:
```ts
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool-schema.js";
export { createSubagentTool, formatHistoryLine } from "./subagent-tool.js";
```

**
**Also repoint the test imports** — three tests import the moved schema symbols from `../src/subagent-tool.js` and will break otherwise:
- `tests/subagent-tool.test.ts` — split its `from "../src/subagent-tool.js"` import so `SubagentToolDetails` (type) and `DEFAULT_TIMEOUT_MS` (and `subagentToolSchema` if present) come from `../src/subagent-tool-schema.js`. Run `grep -n "subagent-tool" tests/subagent-tool.test.ts` to find every symbol and repoint the schema ones.
- `tests/subagent-schema-weight.test.ts:2` — change `import { subagentToolSchema } from "../src/subagent-tool.js"` → `from "../src/subagent-tool-schema.js"`.

- [ ] **Step 4: Run the full gate.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: `biome check` clean; `tsc` emits `dist/` with no errors; all tests pass (incl. the 1836-line `subagent-tool.test.ts` unchanged). No behavior change.

- [ ] **Step 5: Commit.**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts \
        bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts \
        bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/src/index.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts
git commit -m "refactor(subagent): extract schema + types into subagent-tool-schema.ts"
```

---

### Task 2: Create `subagent-tool-render.ts` — move the 16 pure render fns (2a, mechanical)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (delete L243–658: the render cluster + `STREAMING_EXPANDED_TAIL`; add one import line)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts:35` (all 5 symbols → render)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:21` (render symbols → render)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts:134–135` (`formatHistoryLine` → render)

**Interfaces:**
- Consumes: verbatim L243–658 of `subagent-tool.ts`.
- Produces: `subagent-tool-render.ts` exporting `taskPreview`, `workIntentPreview`, `latestMessageLine`, `formatSubagentProgress`, `formatHistoryLine`, `formatSubagentLive`, `formatSubagentTrace`, `renderSubagentCall`, `STREAMING_EXPANDED_TAIL`, `capTraceTail`, `renderSubagentResult`, `deriveSubagentStatus`, `formatSubagentResult` (non-exported helpers `describeLastActivity`, `firstNonEmptyLine`, `truncateEnd` stay module-local).

- [ ] **Step 1: Create `subagent-tool-render.ts`.**

```ts
/**
 * Pure render/parse helpers for the `subagent` tool — stateless string/Theme
 * transforms (args in, string out). Extracted from subagent-tool.ts
 * (behavior-preserving split — no logic change).
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { shortModel } from "./agent-row-display.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { isSddReportActionable, parseSddReport } from "./sdd-report.js";
import type { SpawnSubagentResult } from "./spawn-subagent.js";
import { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";

// === MOVE VERBATIM from subagent-tool.ts L243–658 ===
// function describeLastActivity(...) / firstNonEmptyLine / truncateEnd
// export function taskPreview / workIntentPreview / latestMessageLine /
//   formatSubagentProgress / formatHistoryLine / formatSubagentLive /
//   formatSubagentTrace / renderSubagentCall / capTraceTail /
//   renderSubagentResult / deriveSubagentStatus / formatSubagentResult
// export const STREAMING_EXPANDED_TAIL = 16;
```

Move the entire L243–658 block verbatim. `renderSubagentResult` uses `SubagentToolDetails`, `STREAMING_EXPANDED_TAIL`, `formatSubagentTrace`, `truncateToWidth`, `shortModel`, `parseSddReport`, `isSddReportActionable` — all now imported or co-located in this module. `deriveSubagentStatus`/`formatSubagentResult` use `SpawnSubagentResult`/`SubagentToolDetails` — imported. `Text` is NOT needed here (it lives only in the orchestrator's delegates).

- [ ] **Step 2: Delete L243–658 from `subagent-tool.ts`; import the 7 symbols `execute` uses.**

Remove the render cluster from `subagent-tool.ts`. Add to its import block:

```ts
import {
  deriveSubagentStatus,
  formatSubagentLive,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
  workIntentPreview,
} from "./subagent-tool-render.js";
```

(These are exactly the render symbols `execute` + the `renderCall`/`renderResult` delegates reference. `parseSddReport` is still imported directly from `./sdd-report.js` until Task 5 routes it through `buildDetails`.)

- [ ] **Step 3: Re-point the 3 consumers.**

`src/subagent-context-widget.ts:35`:
```ts
import {
  capTraceTail,
  formatSubagentTrace,
  latestMessageLine,
  renderSubagentCall,
  STREAMING_EXPANDED_TAIL,
} from "./subagent-tool-render.js";
```

`src/subagents-tool.ts:21` (the render half — `DEFAULT_TIMEOUT_MS` already moved in Task 1):
```ts
import { deriveSubagentStatus, taskPreview, workIntentPreview } from "./subagent-tool-render.js";
```

`src/index.ts:134–135` (final shape):
```ts
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool-schema.js";
export { createSubagentTool } from "./subagent-tool.js";
export { formatHistoryLine } from "./subagent-tool-render.js";
```

- [ ] **Step 4: Run the full gate.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: green; `subagent-tool.test.ts` passes unchanged (it imports render symbols — they now resolve via `./subagent-tool-render.js`; update the test's import paths in this step if the test imported them from `./subagent-tool.js`). Run `grep -rln "from .*subagent-tool" bun-apps/pi-agent-ext-subagent/tests/` to find EVERY test importing from the tool module. Repoint each: schema symbols (`SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`) → `../src/subagent-tool-schema.js`; render symbols → `../src/subagent-tool-render.js`. Known hits: `tests/subagent-tool.test.ts` AND `tests/subagent-context-widget.test.ts:5` (`STREAMING_EXPANDED_TAIL`, `workIntentPreview` → `-render.js`). Verify all are green.

- [ ] **Step 5: Commit.**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts \
        bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts \
        bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts \
        bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/src/index.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-context-widget.test.ts
git commit -m "refactor(subagent): extract render layer into subagent-tool-render.ts"
```

---

### Task 3: Create `subagent-tool-run.ts` — `RunContext`/`RunProgress` + pure/IO capture helpers (2b, TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts`
- Create: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts`

**Interfaces:**
- Consumes: `GitScopeOps`, `SubagentScopeCheck`, `computeScopeCheck` (`./git-scope.js`); `computeBaseline`, `RepoBaseline` (`./watchdog/repo-diff.js`); `normalizeWatchdogParam`, `WatchdogResult` (`./watchdog/types.js`); `runWatchdog` (`./watchdog/watchdog.js`); `AgentHistoryEntry` (`./agent-history.js`); `SubagentToolDetails` (`./subagent-tool-schema.js`).
- Produces (this task): types `RunContext`, `RunProgress`, `RunRecordCtx`, `RunRecordDelta`, `SpawnCtx`, `SpawnDeps`; helpers `resolveDisplayModel`, `captureCommitBaseline`, `runScopeCheck`, `captureWatchdogBaseline`, `runWatchdogReview`, `augmentOutputWithScopeViolation`. (Builders `buildRunRecord`/`buildDetails`/`buildSpawnOptions` land in Task 4.)

- [ ] **Step 1: Write the failing unit tests first (TDD).**

Create `tests/subagent-tool-run.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "../src/agent-history.js";
import type { GitScopeOps, SubagentScopeCheck } from "../src/git-scope.js";
import type { RepoBaseline } from "../src/watchdog/repo-diff.js";
import type { WatchdogResult } from "../src/watchdog/types.js";
import {
  augmentOutputWithScopeViolation,
  captureCommitBaseline,
  captureWatchdogBaseline,
  resolveDisplayModel,
  runScopeCheck,
  runWatchdogReview,
} from "../src/subagent-tool-run.js";

const fakeGitOps = (head: string | (() => Promise<string>) = "abc"): GitScopeOps =>
  ({ headCommit: typeof head === "string" ? async () => head : head }) as unknown as GitScopeOps;

test("resolveDisplayModel: requestedModel wins; then capability > tier > mainModel > default", () => {
  assert.equal(resolveDisplayModel("gpt-4", "vision", "big", "m"), "gpt-4");
  assert.equal(resolveDisplayModel(undefined, "vision", "big", "m"), "capability:vision");
  assert.equal(resolveDisplayModel(undefined, undefined, "big", "m"), "tier:big");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, "m"), "m");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, undefined), "default");
});

test("captureCommitBaseline: undefined when scope unset or worktree-isolated", async () => {
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", fakeGitOps()), undefined);
  assert.equal(await captureCommitBaseline(["src/"], "/wt", "/r", fakeGitOps()), undefined);
});

test("captureCommitBaseline: returns headCommit on the real tree", async () => {
  assert.equal(await captureCommitBaseline(["src/"], "/r", "/r", fakeGitOps("deadbeef")), "deadbeef");
});

test("captureCommitBaseline: swallows headCommit throw → undefined", async () => {
  const ops = fakeGitOps(async () => { throw new Error("no git"); });
  assert.equal(await captureCommitBaseline(["src/"], "/r", "/r", ops), undefined);
});

test("runScopeCheck: undefined unless scope set + real tree + baseCommit present", async () => {
  const compute = async () => ({ outOfScope: [], inScope: [] } as unknown as SubagentScopeCheck);
  assert.equal(await runScopeCheck(undefined, "/r", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/wt", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/r", "/r", undefined, fakeGitOps(), compute), undefined);
  const out = await runScopeCheck(["src/"], "/r", "/r", "abc", fakeGitOps(), compute);
  assert.deepEqual(out, { outOfScope: [], inScope: [] } as unknown as SubagentScopeCheck);
});

test("captureWatchdogBaseline: undefined when normalizeWatchdogParam rejects; {opts,baseline} otherwise", () => {
  // undefined param → normalizeWatchdogParam returns a falsy opts → undefined
  assert.equal(captureWatchdogBaseline("/r", undefined, () => ({}) as RepoBaseline), undefined);
  // a truthy param (boolean true) → opts truthy, baseline computed
  const got = captureWatchdogBaseline("/r", true, () => ({ marker: "x" } as unknown as RepoBaseline);
  assert.ok(got && "opts" in got && got.baseline);
});

test("runWatchdogReview: summary line when ran/editGated; empty otherwise; error line on throw", async () => {
  const ran: WatchdogResult = { ran: true, editGated: false, summary: "ok" } as unknown as WatchdogResult;
  const gated: WatchdogResult = { ran: false, editGated: true, summary: "no-diff" } as unknown as WatchdogResult;
  const idle: WatchdogResult = { ran: false, editGated: false, summary: "" } as unknown as WatchdogResult;
  assert.ok((await runWatchdogReview(async () => ran, {} as never, {} as RepoBaseline, "/r", "t")).outputAppend.includes("ok"));
  assert.ok((await runWatchdogReview(async () => gated, {} as never, {} as RepoBaseline, "/r", "t")).outputAppend.includes("no-diff"));
  assert.equal((await runWatchdogReview(async () => idle, {} as never, {} as RepoBaseline, "/r", "t")).outputAppend, "");
  const err = await runWatchdogReview(async () => { throw new Error("boom"); }, {} as never, {} as RepoBaseline, "/r", "t");
  assert.ok(err.outputAppend.includes("watchdog-error: boom"));
  assert.equal(err.result, undefined);
});

test("augmentOutputWithScopeViolation: passthrough when none; appends block when out-of-scope", () => {
  assert.equal(augmentOutputWithScopeViolation("done", undefined), "done");
  const out = augmentOutputWithScopeViolation("done", { outOfScope: ["evil.txt"], inScope: [] } as unknown as SubagentScopeCheck);
  assert.ok(out.startsWith("done\n\n--- ⚠ commit-scope violation (1) ---"));
  assert.ok(out.includes("- evil.txt"));
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts )`
Expected: FAIL — `Cannot find module "../src/subagent-tool-run.js"`.

- [ ] **Step 3: Implement `subagent-tool-run.ts` (types + the 6 helpers).**

Create `src/subagent-tool-run.ts`:

```ts
/**
 * Run-context threading + pure/IO helpers extracted from subagent-tool.ts's
 * `execute`. The orchestrator builds a `RunContext`, mutates a `RunProgress`
 * box from spawn callbacks, and delegates the capture/format/build steps here.
 * Behavior-preserving: every helper mirrors the exact swallow/gate semantics
 * of the inline code it replaces.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import { computeScopeCheck, type GitScopeOps, type SubagentScopeCheck } from "./git-scope.js";
import { computeBaseline, type RepoBaseline } from "./watchdog/repo-diff.js";
import { normalizeWatchdogParam, type WatchdogResult } from "./watchdog/types.js";
import type { runWatchdog } from "./watchdog/watchdog.js";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";

/** Watchdog opts type (non-null return of normalizeWatchdogParam). */
export type WatchdogOpts = NonNullable<ReturnType<typeof normalizeWatchdogParam>>;

/** Immutable per-run context, built in the execute preamble. */
export interface RunContext {
  t0: number;
  runCwd: string;
  spawnCwd: string;
  worktree?: unknown; // Worktree handle (opaque to this module)
  toolCallId: string;
  params: { task: string; agent?: string; commitScope?: string[]; [k: string]: unknown };
  agentDef?: { tools?: string[]; disallowedTools?: string[]; model?: string; tier?: string; prompt?: string };
  modelCtx: {
    requestedModel: string | undefined;
    tier: string | undefined;
    capability: string | undefined;
    mainModel: string | undefined;
    displayModelBeforeResolve: string;
  };
}

/** Mutable progress box — written ONLY from the spawn callbacks, read in teardown/save. */
export interface RunProgress {
  resolvedModel: string | undefined;
  fellBack: boolean;
  lastHistory: AgentHistoryEntry[] | undefined;
  maxToolCallsSeen: number;
}

// ---- pure helpers ----

/** Shown while the subagent runs, before the resolved model is known. */
export function resolveDisplayModel(
  requestedModel: string | undefined,
  capability: string | undefined,
  tier: string | undefined,
  mainModel: string | undefined,
): string {
  return (
    requestedModel ??
    (capability ? `capability:${capability}` : tier ? `tier:${tier}` : mainModel) ??
    "default"
  );
}

/** Phase E: capture repo HEAD before dispatch (real tree only). Swallows throw → undefined. */
export async function captureCommitBaseline(
  scope: string[] | undefined,
  spawnCwd: string,
  runCwd: string,
  gitOps: GitScopeOps,
): Promise<string | undefined> {
  if (scope === undefined || spawnCwd !== runCwd) return undefined;
  try {
    return await gitOps.headCommit(runCwd);
  } catch {
    return undefined;
  }
}

/** Phase K: post-run scope check (real tree + baseline only). Swallows throw → undefined. */
export async function runScopeCheck(
  scope: string[] | undefined,
  spawnCwd: string,
  runCwd: string,
  baseCommit: string | undefined,
  gitOps: GitScopeOps,
  compute: typeof computeScopeCheck,
): Promise<SubagentScopeCheck | undefined> {
  if (scope === undefined || spawnCwd !== runCwd || baseCommit === undefined) return undefined;
  try {
    return await compute(gitOps, runCwd, baseCommit, scope);
  } catch {
    return undefined;
  }
}

/** Phase F: snapshot repo state for the watchdog. `undefined` ⇒ watchdog off / unavailable. */
export function captureWatchdogBaseline(
  spawnCwd: string,
  watchdogParam: unknown,
  compute: typeof computeBaseline,
): { opts: WatchdogOpts; baseline: RepoBaseline } | undefined {
  const opts = normalizeWatchdogParam(watchdogParam);
  if (!opts) return undefined;
  try {
    return { opts, baseline: compute(spawnCwd) };
  } catch {
    return undefined;
  }
}

/** Phase M: soft-gate review. Never throws — appends a summary or `watchdog-error:` line. */
export async function runWatchdogReview(
  run: typeof runWatchdog,
  opts: WatchdogOpts,
  baseline: RepoBaseline,
  spawnCwd: string,
  taskLabel: string,
): Promise<{ result?: WatchdogResult; outputAppend: string }> {
  try {
    const result = await run({ cwd: spawnCwd, before: baseline, opts, taskLabel });
    if (result.ran || result.editGated) {
      return { result, outputAppend: `\n\n--- 🔍 ${result.summary} (soft gate — review findings; not a failure) ---` };
    }
    return { result, outputAppend: "" };
  } catch (e) {
    return { result: undefined, outputAppend: `\n\n--- 🔍 watchdog-error: ${(e as Error).message} ---` };
  }
}

/** Phase L: surface a commit-scope violation into the result text. */
export function augmentOutputWithScopeViolation(
  output: string,
  scopeCheck: SubagentScopeCheck | undefined,
): string {
  if (scopeCheck && scopeCheck.outOfScope.length > 0) {
    const paths = scopeCheck.outOfScope.map((p) => `  - ${p}`).join("\n");
    return `${output}\n\n--- ⚠ commit-scope violation (${scopeCheck.outOfScope.length}) ---\nThe subagent committed path(s) OUTSIDE the declared commitScope:\n${paths}\nInspect before merging — this is the recurring \`git add -A\` sweep signal.`;
  }
  return output;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts )`
Expected: PASS (all helper tests green).

- [ ] **Step 5: Run the full gate + commit.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: green. The new module is not yet wired into `execute` — it compiles standalone and its unit tests pass.

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts
git commit -m "refactor(subagent): add RunContext/RunProgress + capture helpers (TDD)"
```

---

### Task 4: Add `buildRunRecord` + `buildDetails` + `buildSpawnOptions` (2b, TDD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts` (add 3 builders + the `RunRecordCtx`/`RunRecordDelta`/`SpawnCtx`/`SpawnDeps` types)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts` (add builder tests)

**Interfaces:**
- Consumes: `SubagentToolDetails` (schema); `formatSubagentLive`, `deriveSubagentStatus` (render — added to run module's imports this task); `parseSddReport` (`./sdd-report.js`); `generateSubagentRunId`, `SubagentRunPersistence` (`./subagent-run-persistence.js`); `SpawnSubagentOptions` (`./spawn-subagent.js`); `DEFAULT_TIMEOUT_MS` (schema).
- Produces: `buildRunRecord`, `buildDetails`, `buildSpawnOptions`.

- [ ] **Step 1: Write the failing builder tests.**

Append to `tests/subagent-tool-run.test.ts`:

```ts
import { buildDetails, buildRunRecord, buildSpawnOptions, type RunProgress } from "../src/subagent-tool-run.js";
import type { SubagentRunPersistence } from "../src/subagent-run-persistence.js";

type RunRecord = Parameters<SubagentRunPersistence["save"]>[0];

const baseCtx = {
  t0: 1_700_000_000_000,
  runCwd: "/r",
  spawnCwd: "/r",
  toolCallId: "call-1",
  params: { task: "do thing", agent: "impl" },
  modelCtx: { requestedModel: undefined, tier: "big", capability: undefined, mainModel: undefined, displayModelBeforeResolve: "tier:big" },
};

test("buildRunRecord: aborted path JSON-matches the original literal", () => {
  const rec = buildRunRecord(
    { toolCallId: "call-1", agent: "impl", task: "do thing", model: "tier:big", requestedModel: undefined, fellBack: false, tier: "big", runCwd: "/r", t0: 1_700_000_000_000, elapsedMs: 5000 },
    { status: "aborted", exitCode: 0, timedOut: false, output: "Subagent aborted by user.", usage: { input: 1, output: 2 } as never },
  );
  // The original aborted literal had exactly these keys (no stderr/budget/history/report/scopeCheck/watchdog).
  assert.equal(rec.status, "aborted");
  assert.equal(rec.output, "Subagent aborted by user.");
  assert.equal(rec.requestedModel, undefined);
  assert.equal(rec.fellBack, undefined);
  // JSON-equivalent to the original aborted literal (16 keys; no stderr/budget/history/report/scopeCheck/watchdog).
  assert.deepEqual(
    JSON.parse(JSON.stringify(rec)),
    JSON.parse(JSON.stringify({ id: rec.id, toolCallId: "call-1", agent: "impl", task: "do thing", model: "tier:big", requestedModel: undefined, fellBack: undefined, tier: "big", cwd: "/r", status: "aborted", exitCode: 0, timedOut: false, startedAt: new Date(1_700_000_000_000).toISOString(), elapsedMs: 5000, usage: { input: 1, output: 2 }, output: "Subagent aborted by user." })),
  );
});

test("buildRunRecord: normal path includes the extra fields", () => {
  const rec = buildRunRecord(
    { toolCallId: "call-1", agent: "impl", task: "do thing", model: "m1", requestedModel: "req", fellBack: true, tier: "big", runCwd: "/r", t0: 1_700_000_000_000, elapsedMs: 9000 },
    { status: "done", exitCode: 0, timedOut: false, usage: { input: 3 } as never, output: "ok", stderr: undefined, budget: undefined, history: [], report: undefined, scopeCheck: undefined, watchdog: { ran: true } as never },
  );
  assert.equal(rec.requestedModel, "req");      // fellBack ⇒ requestedModel surfaces
  assert.equal(rec.fellBack, true);
  assert.equal(rec.status, "done");
  assert.equal(rec.output, "ok");
});

test("buildDetails: matches the original normal details shape", () => {
  const result = { exitCode: 0, timedOut: false, usage: { input: 1 }, budget: undefined, output: "**Status:** DONE", stderr: "" } as never;
  const d = buildDetails(
    result,
    { model: "m1", requestedModel: "req", fellBack: true },
    { task: "do thing", agent: "impl", elapsedMs: 5000, startedAt: 1_700_000_000_000, scopeCheck: undefined, watchdog: { ran: true } as never },
  );
  assert.equal(d.exitCode, 0);
  assert.equal(d.status, "done");
  assert.equal(d.model, "m1");
  assert.equal(d.requestedModel, "req");
  assert.equal(d.fellBack, true);
  assert.equal(d.report?.status, "DONE"); // parseSddReport parsed the **Status:** block
});

test("buildSpawnOptions: forwards params + wires callbacks that mutate progress", async () => {
  const progress: RunProgress = { resolvedModel: undefined, fellBack: false, lastHistory: undefined, maxToolCallsSeen: 0 };
  const updatedModel: string[] = [];
  const inFlight = { updateModel: (id: string, m: string) => updatedModel.push(m), markFallback: () => {}, update: () => {} } as never;
  const opts = buildSpawnOptions(
    { toolCallId: "call-1", t0: 1_700_000_000_000, params: { task: "t", timeoutMs: 1000 }, agentDef: { tools: ["read"] }, modelCtx: { requestedModel: "req", tier: undefined, capability: undefined, mainModel: undefined, displayModelBeforeResolve: "req" }, spawnCwd: "/r", childSignal: new AbortController().signal },
    progress,
    { getActiveTools: () => undefined, getExtensionTools: () => undefined, inFlight, persistence: undefined, onUpdate: undefined },
  );
  assert.equal(opts.task, "t");
  assert.equal(opts.timeoutMs, 1000);
  assert.deepEqual(opts.tools, ["read"]);
  assert.equal(opts.model, "req");
  // callbacks mutate the shared progress box
  opts.onModelResolved?.("real-model");
  assert.equal(progress.resolvedModel, "real-model");
  assert.deepEqual(updatedModel, ["real-model"]);
  opts.onModelFallback?.("req");
  assert.equal(progress.fellBack, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts )`
Expected: FAIL — `buildRunRecord`/`buildDetails`/`buildSpawnOptions` not exported.

- [ ] **Step 3: Implement the 3 builders.**

Add these imports to the top of `subagent-tool-run.ts`:
```ts
import { type SpawnSubagentOptions } from "./spawn-subagent.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import { parseSddReport } from "./sdd-report.js";
import { type TSchema } from "typebox";
import { DEFAULT_TIMEOUT_MS, type SubagentToolDetails } from "./subagent-tool-schema.js";
import { deriveSubagentStatus, formatSubagentLive, taskPreview } from "./subagent-tool-render.js";
```

Append the builders:

```ts
type SubagentRunRecord = Parameters<SubagentRunPersistence["save"]>[0];

/** Shared fields for the durable record (aborted + normal paths). */
export interface RunRecordCtx {
  toolCallId: string;
  agent: string | undefined;
  task: string;
  model: string;
  requestedModel: string | undefined;
  fellBack: boolean;
  tier: string | undefined;
  runCwd: string;
  t0: number;
  elapsedMs: number;
}

/** Per-path delta. Optional fields are omitted from the record when absent
 *  (matching the original literals' key sets; JSON-equivalent on serialize). */
export interface RunRecordDelta {
  status: SubagentToolDetails["status"];
  exitCode: number;
  timedOut: boolean;
  output: string;
  usage?: SubagentToolDetails["usage"];
  stderr?: string;
  budget?: SubagentToolDetails["budget"];
  history?: AgentHistoryEntry[];
  report?: SubagentToolDetails["report"];
  scopeCheck?: SubagentScopeCheck;
  watchdog?: WatchdogResult;
}

/** Unifies the two persistence.save literals (aborted L897–914 + normal L994–1017). */
export function buildRunRecord(ctx: RunRecordCtx, delta: RunRecordDelta): SubagentRunRecord {
  const rec: SubagentRunRecord = {
    id: generateSubagentRunId(),
    toolCallId: ctx.toolCallId,
    agent: ctx.agent,
    task: ctx.task,
    model: ctx.model,
    requestedModel: ctx.fellBack ? (ctx.requestedModel ?? undefined) : undefined,
    fellBack: ctx.fellBack || undefined,
    tier: ctx.tier,
    cwd: ctx.runCwd,
    status: delta.status,
    exitCode: delta.exitCode,
    timedOut: delta.timedOut,
    startedAt: new Date(ctx.t0).toISOString(),
    elapsedMs: ctx.elapsedMs,
    usage: delta.usage,
    output: delta.output,
  };
  if (delta.stderr !== undefined) rec.stderr = delta.stderr;
  if (delta.budget !== undefined) rec.budget = delta.budget;
  if (delta.history !== undefined) rec.history = delta.history;
  if (delta.report !== undefined) rec.report = delta.report;
  if (delta.scopeCheck !== undefined) rec.scopeCheck = delta.scopeCheck;
  if (delta.watchdog !== undefined) rec.watchdog = delta.watchdog;
  return rec;
}

/** Phase N: the normal-completion details literal (L970–988). */
export function buildDetails(
  result: { exitCode: number; timedOut: boolean; usage?: SubagentToolDetails["usage"]; budget?: SubagentToolDetails["budget"]; output: string },
  model: { model: string; requestedModel: string | undefined; fellBack: boolean },
  extra: { task: string; agent?: string; elapsedMs: number; startedAt: number; scopeCheck?: SubagentScopeCheck; watchdog?: WatchdogResult },
): SubagentToolDetails {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    agent: extra.agent,
    model: model.model,
    requestedModel: model.fellBack ? (model.requestedModel ?? undefined) : undefined,
    fellBack: model.fellBack || undefined,
    taskPreview: taskPreview(extra.task),
    elapsedMs: extra.elapsedMs,
    startedAt: extra.startedAt,
    status: deriveSubagentStatus(result as never),
    usage: result.usage,
    budget: result.budget,
    report: parseSddReport(result.output),
    scopeCheck: extra.scopeCheck,
    watchdog: extra.watchdog,
  };
}

/** Phase I: the 48-line spawn config + its 3 progress-mutating callbacks (L838–886). */
export interface SpawnCtx {
  toolCallId: string;
  t0: number;
  params: Record<string, unknown> & { task: string; tools?: string[]; excludeTools?: string[]; timeoutMs?: number; tokenBudget?: number; spendBudget?: number; retryOnTransient?: boolean; schema?: unknown; schemaRepairAttempts?: number };
  agentDef?: { tools?: string[]; disallowedTools?: string[]; prompt?: string };
  modelCtx: { requestedModel: string | undefined; tier: string | undefined; capability: string | undefined; mainModel: string | undefined };
  spawnCwd: string;
  childSignal: AbortSignal;
}
export interface SpawnDeps {
  getActiveTools?: () => string[] | undefined;
  getExtensionTools?: () => unknown[] | undefined;
  inFlight?: { updateModel?: (id: string, m: string) => void; markFallback?: (id: string, spec: string) => void; update?: (id: string, h: AgentHistoryEntry[]) => void } | undefined;
  persistence?: unknown;
  onUpdate?: ((u: unknown) => void) | undefined;
}

export function buildSpawnOptions(ctx: SpawnCtx, progress: RunProgress, deps: SpawnDeps): SpawnSubagentOptions {
  const { params, agentDef, modelCtx, spawnCwd, childSignal, t0, toolCallId } = ctx;
  const instructions =
    [ctx.params.agent ? `You are the ${ctx.params.agent} for this task.` : undefined, agentDef?.prompt]
      .filter((s): s is string => Boolean(s))
      .join("\n\n") || undefined;
  const defaultActiveTools = deps.getActiveTools?.();
  return {
    task: params.task,
    tools: params.tools ?? agentDef?.tools ?? defaultActiveTools,
    excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
    model: modelCtx.requestedModel,
    tier: modelCtx.tier,
    capability: modelCtx.capability,
    mainModel: modelCtx.mainModel,
    cwd: spawnCwd,
    instructions,
    extensionTools: deps.getExtensionTools?.(),
    externalSignal: childSignal,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenBudget: params.tokenBudget,
    spendBudget: params.spendBudget,
    retryOnTransient: params.retryOnTransient,
    schema: params.schema as TSchema | undefined,
    schemaRepairAttempts: params.schemaRepairAttempts,
    onModelResolved: (id: string) => {
      progress.resolvedModel = id;
      deps.inFlight?.updateModel?.(toolCallId, id);
    },
    onModelFallback: (requestedSpec: string) => {
      progress.fellBack = true;
      deps.inFlight?.markFallback?.(toolCallId, requestedSpec);
    },
    onHistory:
      deps.onUpdate || deps.inFlight || deps.persistence
        ? (history: AgentHistoryEntry[]) => {
            progress.lastHistory = history;
            try {
              const toolCallsNow = history.filter((h) => h.kind === "toolCall").length;
              progress.maxToolCallsSeen = Math.max(progress.maxToolCallsSeen, toolCallsNow);
              deps.inFlight?.update?.(toolCallId, history);
              deps.onUpdate?.({
                content: [{ type: "text" as const, text: formatSubagentLive(history, Date.now() - t0, progress.maxToolCallsSeen) }],
                details: undefined as unknown as SubagentToolDetails,
              });
            } catch {
              // swallowed — progress streaming is diagnostic only
            }
          }
        : undefined,
  } as SpawnSubagentOptions;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts )`
Expected: PASS. If `buildRunRecord`'s aborted key-set assertion is too brittle, relax it to assert the JSON output equals the expected literal (JSON drops `undefined`, so both paths serialize identically to their originals).

- [ ] **Step 5: Run the full gate + commit.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: green. Builders are unit-tested but not yet wired into `execute`.

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts
git commit -m "refactor(subagent): add buildRunRecord/buildDetails/buildSpawnOptions (TDD)"
```

---

### Task 5: Refactor `execute` to thread `RunContext`/`RunProgress` and call the builders (2b, highest risk)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (rewrite `execute` body L698–1023 to use the helpers/builders; add `subagent-tool-run.js` import)

**Interfaces:**
- Consumes: everything produced in Tasks 3–4.
- Produces: an orchestration-only `execute` (~250 lines) behavior-identical to the original.

**Hard invariants to preserve (re-verify each after the rewrite):**
1. worktree setup runs BEFORE the `try` (a throw exits with no `inFlight.end`/teardown).
2. try/finally brackets spawn → return; `finally` does `inFlight.end` + `teardownWorktree`.
3. four swallow patterns: `headCommit`, `computeBaseline`, `computeScopeCheck` → undefined; `runWatchdog` → `watchdog-error:` line; `onHistory` body → silent.
4. abort predicate `childAc.signal.aborted && !signal?.aborted`.
5. four early returns: unknown agentType, invalid schema, aborted, normal.

- [ ] **Step 1: Merge the run-module import into `subagent-tool.ts`'s existing import block.**

```ts
import {
  augmentOutputWithScopeViolation,
  buildDetails,
  buildRunRecord,
  buildSpawnOptions,
  captureCommitBaseline,
  captureWatchdogBaseline,
  resolveDisplayModel,
  runScopeCheck,
  runWatchdogReview,
  type RunProgress,
} from "./subagent-tool-run.js";
import { computeBaseline } from "./watchdog/repo-diff.js";
import { computeScopeCheck } from "./git-scope.js";
```
(`computeBaseline`/`computeScopeCheck` are passed INTO the helpers as deps; `runWatchdog` is passed into `runWatchdogReview`.)
(**Note:** `computeBaseline` and `computeScopeCheck` already exist in `subagent-tool.ts`'s original import block (lines 13 and 22) — do NOT duplicate them. Merge the new `subagent-tool-run.js` import into the block; keep the existing two where they are.)

- [ ] **Step 2: Rewrite the `execute` body to use the helpers.**

Replace the phase bodies with builder/helper calls (keep all control flow — phases B/C validation, D worktree, H `inFlight.start`, the try/finally, the early returns — unchanged in structure):

- **Phase A:** keep `t0`, `runCwd`, `makeWorktree`, `teardownWorktree`, `failEarly`. Add `const progress: RunProgress = { resolvedModel: undefined, fellBack: false, lastHistory: undefined, maxToolCallsSeen: 0 };`
- **Phase E:** `const baseCommit = await captureCommitBaseline(params.commitScope, spawnCwd, runCwd, gitOps);`
- **Phase F:** `const watchdog = captureWatchdogBaseline(spawnCwd, params.watchdog, computeBaseline);` (`{opts, baseline} | undefined`)
- **Phase G:** keep `requestedModel`/`tier`/`capability`/`mainModel`; `const displayModelBeforeResolve = resolveDisplayModel(requestedModel, capability, tier, mainModel);` (drop the inline ternary). Delete the local `resolvedModel`/`fellBack` `let`s — they now live on `progress`.
- **Phase I:** replace the 48-line `spawn({...})` config with:
  ```ts
  const result = await spawn(buildSpawnOptions(
    { toolCallId, t0, params, agentDef, modelCtx: { requestedModel, tier, capability, mainModel }, spawnCwd, childSignal: childAc.signal },
    progress,
    { getActiveTools: options.getActiveTools, getExtensionTools: options.getExtensionTools, inFlight: options.inFlight, persistence: options.persistence, onUpdate },
  ));
  ```
  The three closures now mutate `progress`; the in-line `lastHistory`/`maxToolCallsSeen`/`resolvedModel`/`fellBack` locals are gone.
- **Phase J:** compute `const elapsedMs = Date.now() - t0;`. Keep the abort predicate. In the aborted branch replace the inline `persistence.save({...})` + return-details with:
  ```ts
  const model = progress.resolvedModel ?? displayModelBeforeResolve;
  options.persistence?.save(buildRunRecord(
    { toolCallId, agent: params.agent, task: params.task, model, requestedModel, fellBack: progress.fellBack, tier, runCwd, t0, elapsedMs },
    { status: "aborted", exitCode: result.exitCode, timedOut: false, output: "Subagent aborted by user.", usage: result.usage },
  ));
  return {
    content: [{ type: "text" as const, text: "Subagent aborted by user." }],
    details: {
      exitCode: result.exitCode, timedOut: false, agent: params.agent, model,
      taskPreview: taskPreview(params.task), elapsedMs, startedAt: t0,
      status: "aborted" as const, usage: result.usage,
    },
  };
  ```
  (The aborted `details` return-object stays inline — it is a 9-field early-return literal, deliberately NOT routed through `buildDetails` to avoid merging two different key sets.)
- **Phase K:** `const scopeCheck = await runScopeCheck(params.commitScope, spawnCwd, runCwd, baseCommit, gitOps, computeScopeCheck);`
- **Phase L:** `let output = augmentOutputWithScopeViolation(formatSubagentResult(result), scopeCheck);`
- **Phase M:** replace the inline watchdog block with:
  ```ts
  let watchdogResult: WatchdogResult | undefined;
  if (watchdog?.baseline) {
    const review = await runWatchdogReview(runWatchdog, watchdog.opts, watchdog.baseline, spawnCwd, taskPreview(params.task));
    if (review.result) watchdogResult = review.result;
    if (review.outputAppend) output += review.outputAppend;
  }
  ```
- **Phase N:** replace the inline `details` literal with:
  ```ts
  const model = progress.resolvedModel ?? displayModelBeforeResolve;
  const details = buildDetails(
    result,
    { model, requestedModel, fellBack: progress.fellBack },
    { task: params.task, agent: params.agent, elapsedMs, startedAt: t0, scopeCheck, watchdog: watchdogResult },
  );
  ```
- **Phase O:** replace the inline `persistence.save({...})` with:
  ```ts
  options.persistence?.save(buildRunRecord(
    { toolCallId, agent: params.agent, task: params.task, model, requestedModel, fellBack: progress.fellBack, tier, runCwd, t0, elapsedMs },
    { status: details.status, exitCode: details.exitCode, timedOut: details.timedOut, usage: details.usage, output,
      stderr: result.stderr || undefined, budget: details.budget, history: progress.lastHistory,
      report: details.report, scopeCheck: details.scopeCheck, watchdog: watchdogResult },
  ));
  ```
- **Phase P/Q:** unchanged (`return { content, details }` + `finally` teardown).
- Remove the now-unused direct `parseSddReport` import (it moved into `buildDetails`).

- [ ] **Step 3: Run the full gate — the 1836-line oracle MUST pass unchanged.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: GREEN with zero test changes. This is the behavior-preservation proof: every spawn-fake / inFlight-fake / persistence-fake / gitOps-fake assertion in `subagent-tool.test.ts` still holds because the observable inputs/outputs are identical. If any test fails, the rewrite drifted — fix the rewrite, never the oracle.

- [ ] **Step 4: Commit.**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts
git commit -m "refactor(subagent): thread RunContext/RunProgress through execute via builders"
```

---

### Task 6: Finalize — confirm orchestration-only `execute`, repo-wide typecheck (2c)

**Files:**
- Verify only: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, downstream consumers.

- [ ] **Step 1: Confirm the line target.**

Run: `wc -l bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/src/subagent-tool-{schema,render,run}.ts`
Expected: `subagent-tool.ts` ≈ 250–320 lines (orchestration + delegates); the three siblings hold the rest. If `execute` still exceeds ~320, look for another inline literal to fold — but do NOT change behavior.

- [ ] **Step 2: Repo-wide typecheck of consumers.**

Run: `( cd bun-apps/pi-agent-ext && bun run typecheck 2>/dev/null || true )` then the packages that consume this one:
```
( cd bun-apps/pi-agent && bun run typecheck )
( cd bun-apps/pi-agent-cli && bun run typecheck )
```
Expected: no errors. The public re-exports are stable (`index.ts` only changed source paths), so consumers should be unaffected. If a consumer breaks, it was reaching past the public API — fix the consumer's import to the public surface.

- [ ] **Step 3: Run the package gate one final time.**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: green.

- [ ] **Step 4: (No commit unless Step 1/2 found a change.) If a downstream fix was needed:**

```bash
git add <fixed consumer>
git commit -m "fix(<pkg>): align with subagent-tool split public surface"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** Goal (split into 4 modules) → Tasks 1, 2, 4, 5. Phasing 2a/2b/2c → Tasks 1–2 (2a), 3–5 (2b), 6 (2c). RunContext/RunProgress threading → Task 5. Public API stability → Tasks 1–2 re-point `index.ts`. Hard invariants → Task 5 Step 2 + verification. All spec sections mapped. ✓
- **Placeholder scan:** every step has real code or exact line ranges; no TBD/TODO. ✓
- **Type consistency:** `RunProgress` fields (`resolvedModel`, `fellBack`, `lastHistory`, `maxToolCallsSeen`) match across Task 3 (decl), Task 4 (`buildSpawnOptions` mutates them), Task 5 (reads `progress.*`). `buildRunRecord` ctx/delta field names match the call sites in Task 5. `RunRecordCtx`/`RunRecordDelta`/`SpawnCtx`/`SpawnDeps` declared before use. ✓
- **Known deviation from spec (documented):** the aborted `details` return-object stays inline (Task 5 Phase J) rather than routing through `buildDetails`, because the aborted literal has a 9-field key set distinct from the normal 14-field set — folding them would either add spurious keys or require a flag, raising risk for no cohesion gain. The big DRY win (`buildRunRecord` unifying both `persistence.save` literals) is preserved.
