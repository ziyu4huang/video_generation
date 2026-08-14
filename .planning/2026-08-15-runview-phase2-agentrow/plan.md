# RunView Phase 2 — Agent Row Implementation Plan (Part 1: Tasks 1–8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the RunView adoption and Dispatch B destructive convergence — sweep pass-through shims (C6), migrate all `registry.get()`/`list()` consumers to `view()`/`views()` (C2), and delete the legacy registry accessors.

**Architecture:** The `SubagentInFlightRegistry` (core-runtime) is a process-wide singleton whose only read surface going forward is the immutable `RunView` projection (`view(id)` / `views(opts)`); renderers stop poking raw run fields. Wave 0 first removes pass-through re-export shims in `pi-agent-ext-workflow` so every consumer imports from the owning package barrel. Wave 1 then migrates each remaining `get()`/`list()` caller (production + tests) and finally deletes the legacy accessors and the `"completed"` status coercion from core-runtime, gated by typecheck across all four affected packages.

**Tech Stack:** TypeScript (Bun runtime), `bun:test` + `node:assert/strict`, Biome (workflow pkg `check`), `tsc --noEmit` typecheck gates, bun workspaces under `bun-apps/`.

## Global Constraints

- (a) Registry singleton module-identity — import via package barrels only (`@repo/pi-agent-ext-core-runtime`, `@repo/pi-agent-ext-subagent`), never deep module paths (ADR-0001).
- (b) Renderers never read raw run fields — `RunView` only.
- (c) Status vocabulary is `ActivityStatus` only — no string literals like `"completed"`.
- (d) Gates are the canonical scripts run as `( cd bun-apps/<pkg> && bun run test )` — core-runtime `bun test` + `bunx tsc --noEmit`, subagent & workflow `bun run test` = check + build + test.
- (e) Shell discipline — subshell `( cd ... && ... )` only, no top-level `cd`.
- (f) Subagent barrel `pi-agent-ext-subagent/src/index.ts` re-exports are load-bearing for singleton identity — out of scope for the shim sweep.

---

## Registry API (reference — all tasks)

`SubagentInFlightRegistry` (from `@repo/pi-agent-ext-core-runtime`, file `src/subagent-in-flight.ts`):

```ts
start(run: RunStart): void
update(id: string, history: AgentHistoryEntry[]): void
view(id: string): RunView | undefined
views(opts?: { foreground?: boolean }): RunView[]
updateTaskPreview(id: string, text: string): void
bindInvalidate(id: string, fn: () => void): void
updateModel(id: string, model: string): void
markFallback(id: string, requested: string): void
end(id: string): void
markCompleted(id: string, status: TerminalStatus = "done"): void
markFailed(id: string, status: TerminalStatus = "failed"): void
endBatch(batchId: string): void
abort(id: string): void
```

`RunView` (from `src/run-view.ts`, already exported via the core-runtime barrel):

```ts
export interface RunView {
  readonly id: string;
  readonly batchId?: string;
  readonly foreground: boolean;
  readonly status: ActivityStatus;
  readonly actor: string;
  readonly modelSeg: string;        // fallback-aware, plain text (no theme)
  readonly elapsedMs: number;
  readonly elapsedFrozen: boolean;
  readonly toolCallCount: number;
  readonly latestAction?: string;   // falls back to taskPreview when history is empty
  readonly workIntent?: string;
  readonly badgeText?: string;      // "fallback" when fellBack
  readonly abortable: boolean;
  readonly history: readonly AgentHistoryEntry[];
  readonly startedAt: number;
}
```

`views({ foreground })` filter semantics (verified): when `opts.foreground === undefined` all runs are returned; otherwise only runs with `r.foreground === opts.foreground`.

`agent-row-display.ts` (core-runtime barrel, already tested, zero production consumers — Part 2 adopts them): `renderRunRow(v: RunView)`, `runHeader(v: RunView)`, `renderBadge(v: RunView)`, `renderActivityRow(row: ActivityRow)`, `activityGlyph`, `fmtCost`, `fmtTokensShort`, `fmtElapsed`.

Legacy-field → RunView mapping used throughout Wave 1 test migrations:

| Legacy `InFlightSubagent` field | RunView equivalent |
| --- | --- |
| `status` | `status` (same name, `ActivityStatus`) |
| `taskPreview` | `latestAction` (fallback when history has no tool-call action) |
| `resolvedModel` / `fellBack` / `requestedModel` | `modelSeg` (encodes `requested → resolved` on fallback) + `badgeText === "fallback"` |
| `foreground` | `foreground` |
| `history` | `history` (readonly) |
| `startedAt` / `endedAt` | `startedAt` / `elapsedMs` + `elapsedFrozen` |

## File Structure

**Wave 0 (C6 — shim sweep, `pi-agent-ext-workflow`):**
- Modify: `bun-apps/pi-agent-ext-workflow/src/display.ts` (delete re-export block, keep workflow types) — Task 1
- Modify: `bun-apps/pi-agent-ext-workflow/src/{workflow-control-tool,workflow-manager,task-panel,workflow-ui,index,workflow-commands,workflow-tool}.ts` + `tests/workflow-display.test.ts` (import display symbols from core-runtime) — Task 1
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (delete legacy re-exports) — Task 2
- Modify: `bun-apps/pi-agent-ext-workflow/tests/{workflow-runtime,workflow-parser,builtin-workflows}.test.ts` (import from real modules) — Task 2
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` (drop deprecated `model` alias) — Task 3
- Modify: `bun-apps/pi-agent/src/cli/commands/workflow.ts`, `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`, `bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts` (migrate `{ model }` → `callerModel`) — Task 3

**Wave 1 (C2 — RunView convergence):**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts` + `tests/workflow-in-flight-registry.test.ts` — Task 4
- Modify: `bun-apps/pi-agent-ext-subagent/src/{subagent-tool,subagent-tool-render}.ts` — Task 5
- Modify: `bun-apps/pi-agent-ext-subagent/src/{subagents-command,subagent-context-widget,subagents-tool}.ts` — Task 6
- Modify: `bun-apps/pi-agent-ext-subagent/tests/{subagent-in-flight,subagents-tool,install-subagent-context-widget}.test.ts`; check `bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts` — Task 7
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/{subagent-in-flight,index}.ts` + `bun-apps/pi-agent-ext-core-runtime/tests/subagent-in-flight.test.ts` (destructive delete) — Task 8

---

### Task 1: Remove display.ts pass-through re-exports (Wave 0 / C6)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/display.ts:3-18`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts:12`
- Modify: `bun-apps/pi-agent-ext-workflow/src/task-panel.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/index.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts`

**Interfaces:**
- Consumes: `@repo/pi-agent-ext-core-runtime` barrel exports `activityGlyph`, `fmtCost`, `fmtTokensShort`, `preview`, `renderActivityRow`, `shorten`, `shortModel`, and type `ActivityRow` (all already exported — display.ts re-exports them today).
- Produces: `./display.js` keeps exporting ONLY workflow's own types (`WorkflowAgentSnapshot`, `WorkflowSnapshot`, `WorkflowDisplay`, `WorkflowAgentStatus`, …). All generic agent-row symbols now resolve from `@repo/pi-agent-ext-core-runtime` directly.

- [ ] **Step 1: Enumerate the shim's importers (proof step)**

Run:

```bash
grep -rn "from \"\.\./src/display\.js\"\|from \"\./display\.js\"" bun-apps/pi-agent-ext-workflow/src bun-apps/pi-agent-ext-workflow/tests
```

Expected: hits in `workflow-control-tool.ts`, `workflow-manager.ts` (line 12 imports `preview`), `task-panel.ts`, `workflow-ui.ts`, `index.ts`, `workflow-commands.ts`, `workflow-tool.ts`, `tests/workflow-display.test.ts`. These are the files Step 2 must touch.

- [ ] **Step 2: Delete the re-export block from display.ts**

In `bun-apps/pi-agent-ext-workflow/src/display.ts`, delete lines 3–18 — the extraction comment plus:

```ts
// Generic agent-row display helpers were extracted to @repo/pi-agent-ext-core-runtime
// (so the /subagents TUI is self-contained there). Re-imported for workflow's own
// rendering and re-exported so existing consumers (task-panel, workflow-ui,
// workflow-manager) keep resolving via ./display.js. Direction is unchanged:
// workflow already depends on this package for AgentHistoryEntry/WorkflowErrorCode.
import { activityGlyph, NO_THEME, shorten } from "@repo/pi-agent-ext-core-runtime";

export type { ActivityRow } from "@repo/pi-agent-ext-core-runtime";
export {
  activityGlyph,
  fmtCost,
  fmtTokensShort,
  preview,
  renderActivityRow,
  shorten,
  shortModel,
} from "@repo/pi-agent-ext-core-runtime";
```

Replace with a single direct import (display.ts itself still uses `activityGlyph`, `NO_THEME`, `shorten` internally):

```ts
import { activityGlyph, NO_THEME, shorten } from "@repo/pi-agent-ext-core-runtime";
```

Keep everything from `export type WorkflowAgentStatus = ...` down (workflow's own types: `WorkflowAgentSnapshot`, `WorkflowSnapshot`, `WorkflowDisplay`) untouched.

- [ ] **Step 3: Rewrite every importer found in Step 1**

For each file Step 1 listed, split the display import: workflow types stay from `./display.js` (or `../src/display.js` in tests), generic symbols move to the core-runtime barrel. Example for `workflow-manager.ts:12`:

Before:

```ts
import { preview, type WorkflowSnapshot } from "./display.js";
```

After:

```ts
import { preview } from "@repo/pi-agent-ext-core-runtime";
import type { WorkflowSnapshot } from "./display.js";
```

Apply the same split in `workflow-control-tool.ts`, `task-panel.ts`, `workflow-ui.ts`, `index.ts`, `workflow-commands.ts`, `workflow-tool.ts`, and `tests/workflow-display.test.ts` (test imports `activityGlyph`/`fmtCost`/`fmtTokensShort`/`preview`/`renderActivityRow`/`shorten`/`shortModel`/`ActivityRow` — all from `@repo/pi-agent-ext-core-runtime`). Do NOT change `pi-agent-ext-subagent/src/index.ts` (Global Constraint f).

- [ ] **Step 4: Run the gate (test-first proof the re-route is correct)**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )` (check + build + test)
Expected: PASS. If a file still resolves a removed re-export, `tsc`/build FAILs with "Module './display.js' has no exported member" — fix by moving that symbol to the core-runtime import.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/src/workflow-control-tool.ts bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts bun-apps/pi-agent-ext-workflow/src/task-panel.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/src/index.ts bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts
git commit -m "refactor(workflow): drop display.ts pass-through re-exports, import agent-row symbols from core-runtime (C6)"
```

---

### Task 2: Delete legacy workflow.ts re-exports (Wave 0 / C6)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts:22-24`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-runtime.test.ts:5`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-parser.test.ts:3`
- Test: `bun-apps/pi-agent-ext-workflow/tests/builtin-workflows.test.ts:6`

**Interfaces:**
- Consumes: real modules `./workflow-runtime.js` (`hashAgentCall`), `./workflow-script-parser.js` (`parseWorkflowScript`), `./workflow-timeout.js` (`createLimiter`, `runAgentWithTimeout`).
- Produces: `../src/workflow.js` exports only workflow-engine symbols (`runWorkflow`, `WorkflowMeta`, `JournalEntry`, …) — no pass-throughs.

- [ ] **Step 1: Rewrite the test imports first (they will fail once the shim is gone)**

`tests/workflow-runtime.test.ts:5` — before:

```ts
import { type CheckpointOptions, hashAgentCall, type JournalEntry, runWorkflow } from "../src/workflow.js";
```

after:

```ts
import { hashAgentCall } from "../src/workflow-runtime.js";
import { type CheckpointOptions, type JournalEntry, runWorkflow } from "../src/workflow.js";
```

`tests/workflow-parser.test.ts:3` — before:

```ts
import { parseWorkflowScript } from "../src/workflow.js";
```

after:

```ts
import { parseWorkflowScript } from "../src/workflow-script-parser.js";
```

`tests/builtin-workflows.test.ts:6` — before:

```ts
import { parseWorkflowScript } from "../src/workflow.js";
```

after:

```ts
import { parseWorkflowScript } from "../src/workflow-script-parser.js";
```

- [ ] **Step 2: Run the tests — they still PASS (pure re-route, no behavior change)**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-runtime.test.ts tests/workflow-parser.test.ts tests/builtin-workflows.test.ts )`
Expected: PASS (both import paths still resolve while the shim exists).

- [ ] **Step 3: Delete the shim lines from workflow.ts**

In `bun-apps/pi-agent-ext-workflow/src/workflow.ts`, delete lines 22–24:

```ts
export { hashAgentCall } from "./workflow-runtime.js";
export { parseWorkflowScript } from "./workflow-script-parser.js";
export { createLimiter, runAgentWithTimeout } from "./workflow-timeout.js";
```

Keep the internal `import`s above them (`parseWorkflowScript`, `createStdlib`, `createLimiter`) untouched.

- [ ] **Step 4: Prove no other consumer resolves via workflow.js**

Run:

```bash
grep -rn "hashAgentCall\|createLimiter\|runAgentWithTimeout" bun-apps/pi-agent-ext-workflow/src bun-apps/pi-agent-ext-workflow/tests | grep "from \"\(\.\./src/\)\?\./\?workflow\.js\""
```

Expected: no output. Then run the full gate.

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS (build + tsc prove the deleted exports have no remaining importers).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow.ts bun-apps/pi-agent-ext-workflow/tests/workflow-runtime.test.ts bun-apps/pi-agent-ext-workflow/tests/workflow-parser.test.ts bun-apps/pi-agent-ext-workflow/tests/builtin-workflows.test.ts
git commit -m "refactor(workflow): remove legacy re-exports from workflow.ts, point tests at real modules (C6)"
```

---

### Task 3: Drop deprecated `model` alias from RunWorkflowScriptOptions (Wave 0 / C6)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts:388-393` (alias field) and `:454` (resolution)
- Modify: `bun-apps/pi-agent/src/cli/commands/workflow.ts:~126`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts`
- Test: `bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts`

**Interfaces:**
- Consumes: `RunWorkflowScriptOptions.callerModel?: string` (the canonical four-tier precedence input: `--model` > `PI_MODEL` env > `manifest.model` > pi default).
- Produces: `RunWorkflowScriptOptions` has NO `model` field. All callers pass `callerModel`. `resolvePackOverrides` options likewise use `callerModel` only.

- [ ] **Step 1: Find every `{ model }` caller (proof step)**

Run:

```bash
grep -rn "model:" bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts | grep -v "callerModel\|envModel\|piDefaultModel\|manifest\.model\|resolved\.model\|modelSource\|args({ model"
```

Known hits at time of writing: `workflow-pack.test.ts:445` (`resolvePackOverrides(pack, { model: "cli-model" })`) and `:451` (`resolvePackOverrides(undefined, { args: { y: 2 }, model: "cli" })`). `bun-apps/pi-agent/src/cli/commands/workflow.ts` already passes `callerModel: model` (verified at ~:126) — if the grep shows a raw `model:` there, migrate it to `callerModel:` too.

- [ ] **Step 2: Migrate the test call sites**

In `workflow-pack.test.ts`, rewrite the two hits from Step 1:

```ts
// before
expect(resolvePackOverrides(pack, { model: "cli-model" }).model).toBe("cli-model");
expect(resolvePackOverrides(undefined, { args: { y: 2 }, model: "cli" })).toEqual({ args: { y: 2 }, model: "cli" });

// after
expect(resolvePackOverrides(pack, { callerModel: "cli-model" }).model).toBe("cli-model");
expect(resolvePackOverrides(undefined, { args: { y: 2 }, callerModel: "cli" })).toEqual({ args: { y: 2 }, model: "cli" });
```

Note: `resolvePackOverrides` echoes the resolved model back as `.model` in its RESULT — that output key is unrelated to the options alias and stays. If `resolvePackOverrides` itself reads `opts.model`, change it to `opts.callerModel` in this step. Apply the same migration to any `runWorkflowScript({ ..., model })` calls in either test file.

- [ ] **Step 3: Run the migrated tests — FAIL before the implementation change**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-pack.test.ts )`
Expected: FAIL — the migrated tests pass `callerModel`, but the resolution still reads `opts.callerModel ?? opts.model` (works) — so if Step 2 is complete and correct this may already PASS. Either way, proceed: the real gate is Step 5 after the alias is deleted.

- [ ] **Step 4: Delete the alias from workflow-pack.ts**

In `src/workflow-pack.ts`, delete the deprecated field (~:388-393):

```ts
  /**
   * @deprecated use `callerModel`. Kept as a backward-compat alias so existing
   * callers/tests that pass `{ model }` keep working — `runWorkflowScript`
   * treats `opts.callerModel ?? opts.model` as the caller value.
   */
  model?: string;
```

and collapse the resolution (~:454):

```ts
// before
const callerModel = opts.callerModel ?? opts.model;

// after
const callerModel = opts.callerModel;
```

Also update the comment above it (remove the sentence about the legacy `opts.model` field) and any `@deprecated` mention of `model` in the four-tier precedence doc comment (~:388).

- [ ] **Step 5: Run both gates**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS.

Run: `( cd bun-apps/pi-agent && bun test src/cli/__tests__/workflow-command.test.ts )`
Expected: PASS (proves the CLI passes `callerModel`, not the deleted alias).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts bun-apps/pi-agent/src/cli/commands/workflow.ts bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts
git commit -m "refactor(workflow): remove deprecated RunWorkflowScriptOptions.model alias (C6)"
```

---

### Task 4: workflow-manager updateInFlight → updateTaskPreview + test migration to view()/views() (Wave 1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts:714-719`
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-in-flight-registry.test.ts`

**Interfaces:**
- Consumes: `registry.updateTaskPreview(id: string, text: string): void`; `registry.view(id): RunView | undefined`; `registry.views(opts?: { foreground?: boolean }): RunView[]`; RunView field map (see Registry API section above).
- Produces: `workflow-manager.ts` no longer calls `registry.get(id)` and never mutates `entry.taskPreview` directly — only `updateTaskPreview`.

- [ ] **Step 1: Migrate the registry test to view()/views() (write the failing shape)**

In `tests/workflow-in-flight-registry.test.ts` (10 tests, all currently reading via `reg.get(...)` / `reg.list()`), rewrite reads using the field map:

```ts
// before (legacy)
const entry = reg.get(id);
assert.ok(entry?.taskPreview.includes("phase 2"));
const running = reg.list().filter((e) => !isTerminalStatus(e.status));

// after (RunView)
const v = reg.view(id);
assert.ok(v?.latestAction?.includes("phase 2")); // taskPreview surfaces via latestAction
const running = reg.views().filter((v) => !isTerminalStatus(v.status));
```

Add/extend one test asserting the new preview path end-to-end:

```ts
test("updateTaskPreview is the only preview mutation path", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "wf-1", actor: "workflow", taskPreview: "starting", startedAt: Date.now() });
  reg.updateTaskPreview("wf-1", "phase 2/3 · agent b");
  const v = reg.view("wf-1");
  assert.ok(v);
  assert.equal(v.latestAction, "phase 2/3 · agent b"); // no tool-call history → taskPreview wins
});
```

- [ ] **Step 2: Run the test — verify the new path FAILS or the migration is green**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-in-flight-registry.test.ts )`
Expected: PASS on migrated reads (`view`/`views` already exist); the new `updateTaskPreview` test also PASSES against the current registry — its purpose is to pin the contract Task 4's production change must satisfy.

- [ ] **Step 3: Switch updateInFlight to the registry API**

In `src/workflow-manager.ts` (~:714), before:

```ts
private updateInFlight(managed: ManagedRun): void {
  if (!this.inFlight) return;
  const entry = this.inFlight.get(workflowInFlightId(managed.runId));
  if (entry) entry.taskPreview = workflowPreview(managed.snapshot);
}
```

after:

```ts
private updateInFlight(managed: ManagedRun): void {
  if (!this.inFlight) return;
  this.inFlight.updateTaskPreview(workflowInFlightId(managed.runId), workflowPreview(managed.snapshot));
}
```

(`updateTaskPreview` is already a delete-by-key no-op when the entry is gone, so the `if (entry)` guard is subsumed.)

- [ ] **Step 4: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts bun-apps/pi-agent-ext-workflow/tests/workflow-in-flight-registry.test.ts
git commit -m "refactor(workflow): updateInFlight uses registry.updateTaskPreview, tests migrate to view()/views() (C2)"
```

---

### Task 5: subagent-tool renderCall reads view(id), not get(id) (Wave 1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:393-400`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts:268-305`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool-render.test.ts` (existing suite; extend)

**Interfaces:**
- Consumes: `registry.view(id): RunView | undefined`; `RunView.modelSeg: string` (fallback-aware — encodes `requested → resolved` when a fallback occurred) and `RunView.badgeText?: string` (`"fallback"`).
- Produces: `renderSubagentCall(args, theme)` args type replaces the `resolvedModel?: string` + `fellBack?: boolean` pair with `modelSeg?: string`. `subagent-tool.ts` renderCall no longer calls `registry.get`.

- [ ] **Step 1: Update renderSubagentCall's contract test-first**

In `subagent-tool-render.ts`, change the args type (~:268):

```ts
// before
export function renderSubagentCall(
  args: {
    agent?: string;
    model?: string;
    capability?: string;
    tier?: string;
    task: string;
    resolvedModel?: string;
    /** True when the model resolution fell back (actual model differs from requested). */
    fellBack?: boolean;
  },
  theme: Theme,
): string {

// after
export function renderSubagentCall(
  args: {
    agent?: string;
    model?: string;
    capability?: string;
    tier?: string;
    task: string;
    /** Fallback-aware model segment from RunView.modelSeg (e.g. "claude-opus-4-1 → glm-5.2"). */
    modelSeg?: string;
  },
  theme: Theme,
): string {
```

Replace the resolved-segment logic (~:295-301):

```ts
// before
const resolvedShort = args.resolvedModel ? shortModel(args.resolvedModel) : undefined;
if (resolvedShort && resolvedShort !== slot) {
  const label = args.fellBack ? `→ ${resolvedShort}` : resolvedShort;
  ...
}

// after — modelSeg already carries the "→" fallback marker from buildRunView
if (args.modelSeg && args.modelSeg !== slot) {
  const label = args.modelSeg;
  ...
}
```

Update the render tests that pass `{ resolvedModel, fellBack }` to pass `{ modelSeg: "claude-opus-4-1 → glm-5.2" }` (fallback case) / `{ modelSeg: "glm-5.2" }` (plain case) and keep their expected output strings identical.

- [ ] **Step 2: Run the render tests — FAIL until call sites migrate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-render.test.ts )`
Expected: FAIL initially on the type change (TS/excess-property via build) — resolve by completing Step 3, then PASS with unchanged expected strings.

- [ ] **Step 3: Switch renderCall to view()**

In `subagent-tool.ts` renderCall (~:393-400), before:

```ts
const entry = options.inFlight?.get(context.toolCallId);
const resolvedModel = entry?.resolvedModel;
const fellBack = entry?.fellBack;
options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
text.setText(renderSubagentCall({ ...args, resolvedModel, fellBack }, theme));
```

after:

```ts
const v = options.inFlight?.view(context.toolCallId);
options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
text.setText(renderSubagentCall({ ...args, modelSeg: v?.modelSeg }, theme));
```

Global Constraint (b): renderers read RunView only — `modelSeg` already encodes fallback, so no `fellBack` read remains.

- [ ] **Step 4: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS (check + build + test).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts bun-apps/pi-agent-ext-subagent/tests/subagent-tool-render.test.ts
git commit -m "refactor(subagent): renderCall consumes RunView via registry.view, modelSeg replaces resolvedModel/fellBack (C2)"
```

---

### Task 6: list() callers → views() (Wave 1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-command.ts:70`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts:239,259`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:425`
- Test: covered by the subagent package suite (Task 7 migrates the dedicated fakes)

**Interfaces:**
- Consumes: `registry.views(opts?: { foreground?: boolean }): RunView[]` — verified semantics: `opts.foreground === undefined` returns all runs; otherwise filters `r.foreground === opts.foreground`.
- Produces: no production file in `pi-agent-ext-subagent/src` calls `registry.list()`; the `getRunning` closures feed `RunView[]` to `SubagentViewer` / `SubagentContextWidget` (whose render paths consume RunView fields per the field map).

- [ ] **Step 1: Verify views() filter semantics (proof step, do not skip)**

Run:

```bash
grep -n -A 6 "views(opts" bun-apps/pi-agent-ext-core-runtime/src/subagent-in-flight.ts
```

Expected output confirms:

```ts
views(opts?: { foreground?: boolean }): RunView[] {
  const now = Date.now();
  return [...this.runs.values()]
    .filter((r) => opts?.foreground === undefined || r.foreground === opts.foreground)
    .map((r) => buildRunView(r, now));
}
```

So `views({ foreground: false })` returns exactly the background runs (the idle-guard semantics we need).

- [ ] **Step 2: Migrate the three call sites**

`subagents-command.ts:70`:

```ts
// before
getRunning: () => subagentInFlight.list(),
// after
getRunning: () => subagentInFlight.views(),
```

`subagent-context-widget.ts:239`:

```ts
// before
const widget = new SubagentContextWidget({ getRunning: () => opts.registry.list() });
// after
const widget = new SubagentContextWidget({ getRunning: () => opts.registry.views() });
```

`subagent-context-widget.ts:259` (idle churn guard — `list().some(r => !r.foreground)` means "at least one background run"):

```ts
// before
if (!opts.registry.list().some((r) => !r.foreground)) return;
// after
if (opts.registry.views({ foreground: false }).length === 0) return;
```

`subagents-tool.ts:425` (batch progress filter):

```ts
// before
const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
// after
const group = (options.inFlight?.views() ?? []).filter((v) => v.batchId === toolCallId);
```

If `SubagentViewer` / `SubagentContextWidget` internals still type `getRunning` as returning `InFlightSubagent[]`, migrate those reads to the RunView field map (`status`→`status`, `taskPreview`→`latestAction`, `resolvedModel`/`fellBack`→`modelSeg`/`badgeText`, `startedAt`/`endedAt`→`startedAt`/`elapsedMs`+`elapsedFrozen`) in this same task — Global Constraint (b). Do not touch `pi-agent-ext-subagent/src/index.ts` re-exports (Global Constraint f).

- [ ] **Step 3: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-command.ts bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts
git commit -m "refactor(subagent): getRunning closures feed RunView via registry.views (C2)"
```

---

### Task 7: Migrate subagent test suites + obsidian check (Wave 1)

**Files:**
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts` (15 legacy get/list lifecycle tests)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (65 tests, heavy get/list)
- Test: `bun-apps/pi-agent-ext-subagent/tests/install-subagent-context-widget.test.ts` (fake registry exposes only `.list()`)
- Check: `bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts:318`

**Interfaces:**
- Consumes: `view(id): RunView | undefined`, `views(opts?): RunView[]`, the RunView field map (see Registry API section).
- Produces: no test in `pi-agent-ext-subagent/tests` invokes `get()`/`list()`; the install-widget fake registry exposes `views()` (and whatever the widget path needs) instead of `list()`.

- [ ] **Step 1: Migrate subagent-in-flight.test.ts (lifecycle)**

Rewrite each legacy assertion using the field map; the canonical before/after pattern:

```ts
// before
reg.start({ id: "s1", ... });
reg.update("s1", history);
const e = reg.get("s1")!;
assert.equal(e.status, "running");
assert.equal(reg.list().length, 1);

// after
reg.start({ id: "s1", ... });
reg.update("s1", history);
const v = reg.view("s1")!;
assert.equal(v.status, "running");
assert.equal(v.views().length, 1);
```

All 15 tests: `reg.get(id)!.<field>` → `reg.view(id)!.<mappedField>`; `reg.list()` → `reg.views()` (add `{ foreground: ... }` where the test filtered on `foreground`). Status assertions use `ActivityStatus` literals only (`"running"`, `"done"`, `"failed"`, …) — never `"completed"` (Global Constraint c).

- [ ] **Step 2: Migrate subagents-tool.test.ts (batch flows)**

Same transformation across the 65 tests: every fake-registry inspection `(reg.get(id))` → `reg.view(id)` and `reg.list().filter(...)` → `reg.views().filter(...)` with mapped fields (`e.batchId` → `v.batchId`, `e.status` → `v.status`, `e.taskPreview` → `v.latestAction`).

- [ ] **Step 3: Migrate the install-widget fake registry**

In `install-subagent-context-widget.test.ts`, the fake registry currently implements only `.list()`. Change it to expose `.views()`:

```ts
// before
const fakeRegistry = { list: () => runs };

// after
const fakeRegistry = {
  views: (opts?: { foreground?: boolean }) =>
    runs.filter((r) => opts?.foreground === undefined || r.foreground === opts.foreground),
};
```

(If the widget under test calls other registry methods — `bindInvalidate`, `abort` — keep those on the fake as-is.)

- [ ] **Step 4: Check obsidian for get/list usage**

Run:

```bash
grep -n "\.get(\|\.list(" bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts
```

At time of writing `subagent.ts:318` only passes the registry through (`inFlight: getSubagentInFlightRegistry()`) with no direct `get`/`list` calls — expected: no output. If a hit appears, migrate it with the same field map before proceeding.

- [ ] **Step 5: Run both gates**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS.

Run: `( cd bun-apps/pi-agent-ext-obsidian && bunx tsc --noEmit )`
Expected: PASS (exit 0, no output).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts bun-apps/pi-agent-ext-subagent/tests/install-subagent-context-widget.test.ts bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts
git commit -m "test(subagent): migrate in-flight and tool suites to view()/views(), fake registry exposes views (C2)"
```

---

### Task 8: Destructive delete — registry.get/list, InFlightSubagent export, "completed" coercion (Wave 1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/subagent-in-flight.ts:113-117,205-212` (get/list), `:94-106` (start coercion)
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/index.ts:~94` (deprecated export)
- Test: `bun-apps/pi-agent-ext-core-runtime/tests/subagent-in-flight.test.ts`

**Interfaces:**
- Consumes: everything Tasks 4–7 produced — zero remaining `get()`/`list()` callers in production code.
- Produces: `SubagentInFlightRegistry` public surface = start/update/view/views/updateTaskPreview/bindInvalidate/updateModel/markFallback/end/markCompleted/markFailed/endBatch/abort. `@repo/pi-agent-ext-core-runtime` barrel no longer exports `InFlightSubagent` (keep `TerminalStatus`). `start()` accepts `ActivityStatus` only.

- [ ] **Step 1: Tighten the core-runtime tests first (failing shape)**

In `core-runtime/tests/subagent-in-flight.test.ts`:
1. Delete the test covering the `"completed" → "done"` coercion (asserts `start({ ..., status: "completed" })` yields `"done"`).
2. Change any fixture passing `status: "completed"` to `status: "done"`.
3. Add the negative compile-level pin — `start`'s param type no longer admits `"completed"`:

```ts
test("start accepts ActivityStatus only (no legacy 'completed' literal)", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "s1", actor: "subagent", startedAt: Date.now(), status: "done" });
  assert.equal(reg.view("s1")?.status, "done");
});
```

- [ ] **Step 2: Run core-runtime tests — FAIL until the implementation catches up**

Run: `( cd bun-apps/pi-agent-ext-core-runtime && bun test tests/subagent-in-flight.test.ts )`
Expected: FAIL (any remaining `"completed"` fixture now mismatches the tightened expectations; deleted coercion test is gone). This confirms the tests now encode the post-delete contract.

- [ ] **Step 3: Delete the legacy surface**

In `src/subagent-in-flight.ts`, delete `get()`:

```ts
  /** @internal — Dispatch B removes; use view(). */
  get(id: string): InFlightSubagent | undefined {
    return this.runs.get(id);
  }
```

delete `list()`:

```ts
  /** @deprecated use views(). */
  list(): InFlightSubagent[] {
    return [...this.runs.values()];
  }
```

and remove the coercion in `start()` (~:94-106) — before:

```ts
start(run: Omit<InFlightSubagent, "status"> & { status?: ActivityStatus | "completed" }): void {
  ...
  const status: ActivityStatus =
    run.status === undefined || run.status === "running"
      ? "running"
      : run.status === "completed"
        ? "done"
        : run.status;
  this.runs.set(run.id, { ...run, status, foreground: run.foreground ?? false });
}
```

after (ActivityStatus only — Global Constraint c):

```ts
start(run: Omit<InFlightSubagent, "status"> & { status?: ActivityStatus }): void {
  const status: ActivityStatus = run.status ?? "running";
  this.runs.set(run.id, { ...run, status, foreground: run.foreground ?? false });
}
```

Also delete the doc-comment sentence referencing the `"completed"` coercion (~:48) and update the `@deprecated` markers on the class if they reference get/list.

In `src/index.ts` (~:94), split the deprecated export — remove `InFlightSubagent`, keep `TerminalStatus`:

```ts
// before
/** @deprecated Dispatch B removes — use RunView via registry.view(s)(). */
export type { InFlightSubagent, TerminalStatus } from "./subagent-in-flight.js";

// after
export type { TerminalStatus } from "./subagent-in-flight.js";
```

(`InFlightSubagent` stays as an internal type inside `subagent-in-flight.ts` — only the barrel export goes.)

- [ ] **Step 4: Run all four gates**

Run: `( cd bun-apps/pi-agent-ext-core-runtime && bun test && bunx tsc --noEmit )`
Expected: PASS.

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS.

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS.

Run: `( cd bun-apps/pi-agent-ext-obsidian && bunx tsc --noEmit )`
Expected: PASS.

- [ ] **Step 5: grep proof — no registry get/list remains**

Run:

```bash
grep -rn "\.get(\|\.list(" bun-apps/pi-agent-ext-core-runtime/src bun-apps/pi-agent-ext-subagent/src bun-apps/pi-agent-ext-workflow/src | grep -i registry
```

Expected: no output (or only non-registry hits such as `Map` internals inside `subagent-in-flight.ts` itself — those are `this.runs.get(...)`, not registry-API calls, and are acceptable only inside `subagent-in-flight.ts`).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/subagent-in-flight.ts bun-apps/pi-agent-ext-core-runtime/src/index.ts bun-apps/pi-agent-ext-core-runtime/tests/subagent-in-flight.test.ts
git commit -m "feat(core-runtime)!: delete registry get/list, InFlightSubagent barrel export, and legacy 'completed' coercion (C2, Dispatch B)"
```

---

<!-- PART 2 APPENDED BELOW -->
