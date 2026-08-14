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
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:393-408` (renderCall's `.get(context.toolCallId)` lives at `:402` — moved here from `subagents-tool.ts` by #1340's child-dispatch extraction; `subagents-tool.ts` itself now only calls `.list()` at `:450`)
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

In `subagent-tool.ts` renderCall (`.get(context.toolCallId)` at `:402`), before:

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
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:450` (batch progress `.list()` filter — drifted from :425 by #1340)
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

`subagents-tool.ts:450` (batch progress filter):

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

# RunView Phase 2 — Agent Row Implementation Plan (Part 2: Tasks 9–14, Wave 2)

> Continues Part 1 (Tasks 1–8, done). All Part 1 **Global Constraints** carry over unchanged: (a) barrel-singleton identity, (b) renderers never read raw run fields, (c) `ActivityStatus` only, (d) canonical gates as `( cd bun-apps/<pkg> && bun run test )`, (e) subshell `cd` only, (f) subagent barrel re-exports are load-bearing.

**Goal (Wave 2 — C1 AgentRow render-site convergence):** every render surface in `pi-agent-ext-subagent` and `pi-agent-ext-workflow` speaks the shared `agent-row-display.ts` visual language — `fmtElapsed`/`fmtCost`/`activityGlyph`/`renderBadge`/`runHeader`/`renderRunRow` from the `@repo/pi-agent-ext-core-runtime` barrel — and stops hand-rolling per-site elapsed math, model-seg fallback ternaries, and glyph switches. These helpers currently have **zero production consumers**; Wave 2 is their adoption.

**Dependency:** Tasks 10, 11, and 12 ride Part 1 Task 6's `list()` → `views()` migration (`registry.views()` returning `RunView[]`); do not start them before Task 6's commits land.

---

### Task 9: subagent-tool-render.ts — fmtElapsed + RunView modelSeg replace per-site copies (Wave 2)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts:122` (elapsed copy #1)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts:258` (elapsed copy #2)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts:412-418` (hand-rolled modelSeg fallback) and `:423` (elapsed copy #3)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool-render.test.ts` (existing suite — expected strings unchanged)

**Interfaces:**
- Consumes: `fmtElapsed(ms: number): string` (returns e.g. `"12.3s"`) from `@repo/pi-agent-ext-core-runtime`; `RunView.modelSeg: string` (fallback-aware, plain text).
- Produces: `subagent-tool-render.ts` contains zero `(ms / 1000).toFixed(1)` expressions and zero `fellBack ? ... : ...` model-seg ternaries. `renderSubagentResult` accepts an optional fallback-aware `modelSeg` (RunView-sourced) so the settled meta line no longer re-derives it.

- [ ] **Step 1: Import the barrel helpers (test-first)**

Update the render tests' import surface first, then in `subagent-tool-render.ts` add:

```ts
import { fmtElapsed } from "@repo/pi-agent-ext-core-runtime";
```

- [ ] **Step 2: Replace elapsed copy #1 — formatSubagentProgress (~:122)**

```ts
// before
const elapsedS = (elapsedMs / 1000).toFixed(1);
return `↳ ${activity}\n  ↳ ${elapsedS}s elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;

// after — fmtElapsed already carries the trailing "s"
return `↳ ${activity}\n  ↳ ${fmtElapsed(elapsedMs)} elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
```

- [ ] **Step 3: Replace elapsed copy #2 — collapsed trace progress line (~:258)**

```ts
// before
const progress = `${(elapsedMs / 1000).toFixed(1)}s · ${toolCalls} call${toolCalls === 1 ? "" : "s"}`;

// after
const progress = `${fmtElapsed(elapsedMs)} · ${toolCalls} call${toolCalls === 1 ? "" : "s"}`;
```

- [ ] **Step 4: Delete the hand-rolled modelSeg fallback + elapsed copy #3 — settled meta (~:412-423)**

The hand-rolled ternary duplicates `buildRunView`'s fallback encoding ("requested → actual", shortModel-ed). Delete it and take the segment from the caller (which holds a RunView per Part 1 Task 5); degrade gracefully when no view is available:

```ts
// before
const modelSeg =
  d.fellBack && d.requestedModel
    ? `${shortModel(d.requestedModel)} → ${shortModel(d.model) ?? "default"}`
    : (shortModel(d.model) ?? "default");
const meta =
  theme.fg("muted", `${modelSeg} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`) + ...;

// after — modelSeg comes in fallback-aware from the RunView-carrying caller
const modelSeg = opts?.modelSeg ?? (shortModel(d.model) ?? "default");
const meta =
  theme.fg("muted", `${modelSeg} · ${fmtElapsed(d.elapsedMs)}${usageStr}`) + ...;
```

Thread `opts?: { modelSeg?: string }` through `renderSubagentResult`'s signature; the caller in `subagent-tool.ts` passes `view?.modelSeg` when it holds one (Part 1 Task 5's `view(context.toolCallId)`). Global Constraint (b): the renderer itself no longer reads `fellBack`/`requestedModel`.

- [ ] **Step 5: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS — `fmtElapsed(x)` is byte-identical to `(x / 1000).toFixed(1) + "s"`, so every expected string in `subagent-tool-render.test.ts` is unchanged.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagent-tool-render.test.ts
git commit -m "refactor(subagent): render adopts fmtElapsed + RunView modelSeg, deletes 3 elapsed copies and the fallback ternary (C1)"
```

---

### Task 10: subagents-tool.ts — buildLiveTable on RunView[], delete formatModelSeg and inline freeze math (Wave 2)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:756-761` (delete `formatModelSeg`; used at `:772` in `formatSlotMeta` and `:808` in `buildLiveTable`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:798-816` (`buildLiveTable(entries: InFlightSubagent[], ...)` → `(views: RunView[], ...)`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:450` (caller: `options.inFlight?.views()` + `batchId` filter — already migrated by Part 1 Task 6)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:675` and `:874` (remaining `toFixed(1)` headers → `fmtElapsed`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (Part 1 Task 7 already migrated it to views())

**Interfaces:**
- Consumes: `RunView` (`modelSeg`, `elapsedMs` frozen-at-terminal, `elapsedFrozen`, `latestAction`), `registry.views(opts?): RunView[]`, `fmtElapsed(ms): string` — all from `@repo/pi-agent-ext-core-runtime`.
- Produces: `buildLiveTable(views: RunView[]): string` — pure function over frozen-elapsed views; `formatModelSeg` deleted (RunView `modelSeg` is its replacement); zero `isTerminalStatus ? (e.endedAt ?? now) : now` freeze math outside core-runtime.

**DEPENDS ON Part 1 Task 6** (list()→views() migration of the `:450` batch filter).

- [ ] **Step 1: Rewrite buildLiveTable over RunView (test-first)**

Update `tests/subagents-tool.test.ts`'s `buildLiveTable` fixtures from `InFlightSubagent` objects to `RunView` objects (field map in Part 1: `resolvedModel`/`fellBack`/`requestedModel` → `modelSeg`; `startedAt`/`endedAt` + terminal math → `elapsedMs` frozen at terminal; `taskPreview` → `latestAction`). Then:

```ts
// before
export function buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string {
  ...
  const slot = formatModelSeg(e.resolvedModel ?? e.model ?? "default", e.requestedModel, e.fellBack);
  const glyph = isTerminalStatus(e.status) ? "✓" : "⏱";
  // Terminal rows freeze at endedAt (falling back to `now` defensively); only
  // running rows tick.
  const end = isTerminalStatus(e.status) ? (e.endedAt ?? now) : now;
  const elapsed = `${((end - e.startedAt) / 1000).toFixed(1)}s`;
  const action = summarizeLatestAction(e.history) ?? truncateToWidth(e.taskPreview ?? e.workIntent ?? "", 40);
  return `[${idxLabel}] ${slot} ${glyph} ${elapsed} · ${action}`;

// after — RunView already encodes everything: modelSeg, frozen elapsedMs, latestAction
export function buildLiveTable(views: RunView[]): string {
  const sorted = [...views].sort((a, b) => {
    const ia = childDispatchIndex(a.id);
    const ib = childDispatchIndex(b.id);
    return (Number.isNaN(ia) ? Infinity : ia) - (Number.isNaN(ib) ? Infinity : ib);
  });
  return sorted
    .map((v) => {
      const idx = childDispatchIndex(v.id);
      const idxLabel = Number.isNaN(idx) ? "?" : String(idx);
      const glyph = v.elapsedFrozen ? "✓" : "⏱";
      const action = summarizeLatestAction(v.history) ?? truncateToWidth(v.latestAction ?? "", 40);
      return `[${idxLabel}] ${v.modelSeg} ${glyph} ${fmtElapsed(v.elapsedMs)} · ${action}`;
    })
    .join("\n");
}
```

The `now` parameter and the entire freeze comment block go away — `buildRunView` already freezes `elapsedMs` at terminal (Global Constraint (b): the freeze policy has exactly one home, core-runtime). Update the `execute()` caller at `:450`-adjacent code to pass `(options.inFlight?.views() ?? []).filter((v) => v.batchId === toolCallId)` (rides Part 1 Task 6).

- [ ] **Step 2: Delete formatModelSeg, migrate its two callers**

- `formatSlotMeta` (~:772): `formatModelSeg(slot.model, slot.requestedModel, slot.fellBack)` → callers pass the RunView-sourced segment; settled slots that have no view degrade to `shortModel(slot.model) ?? "default"`, and the `(slot.elapsedMs / 1000).toFixed(1)s` inside → `fmtElapsed(slot.elapsedMs)`.
- `buildLiveTable` (~:808): covered by Step 1 (`v.modelSeg`).
- Delete the `formatModelSeg` declaration (~:756-761) and its doc block.

- [ ] **Step 3: Sweep the remaining toFixed(1) headers**

`:675` (`renderBatchResult`) and `:874` (`renderSubagentsResult`): `${(details.elapsedMs / 1000).toFixed(1)}s` → `${fmtElapsed(details.elapsedMs)}`. Byte-identical output.

- [ ] **Step 4: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS (subagents-tool.test.ts already view-based after Part 1 Task 7; expected strings unchanged since `fmtElapsed` matches the old format exactly).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "refactor(subagent): buildLiveTable consumes RunView[] — deletes formatModelSeg and inline freeze math (C1)"
```

---

### Task 11: subagent-viewer.ts — adopt runHeader/renderBadge, delete followGlyph, getRunning returns RunView[] (Wave 2)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts:131` and `:143` (`getRunning?: () => InFlightSubagent[]` → `() => RunView[]`, in `ViewerOpts` and the `SubagentViewer` field)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts:535-539` (completed-output header stops reading `r.status`/`r.elapsedMs` raw — takes RunView via `views()`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts:600-604` (follow header — same)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts:664` (delete `followGlyph` — second glyph impl)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts` (56 viewer tests adapt)

**Interfaces:**
- Consumes: `runHeader(v: RunView): string` (`[id] glyph elapsed · latestAction`, theme-free), `renderBadge(v: RunView, theme): string`, `activityGlyph(status: ActivityStatus): { icon, color }` — from `@repo/pi-agent-ext-core-runtime`. **These currently have ZERO production callers — this task is their adoption.**
- Produces: `SubagentViewer` renders live/follow rows exclusively from `RunView`; exactly one glyph implementation repo-wide (`activityGlyph`); `getRunning` is `() => RunView[]` end to end.

**DEPENDS ON Part 1 Task 6** (`subagents-command.ts:70` already feeds `registry.views()` into `getRunning`).

- [ ] **Step 1: Retype getRunning (test-first)**

Update the 56 viewer tests' `getRunning` fakes to return `RunView` objects (field map in Part 1), then change both declarations:

```ts
// before (both :131 and :143)
getRunning?: () => InFlightSubagent[];

// after
getRunning?: () => RunView[];  // fed by registry.views() (Part 1 Task 6)
```

- [ ] **Step 2: Completed/follow headers read RunView only (~:535-539, ~:600-604)**

```ts
// before (follow head, ~:604)
const head = `${followGlyph(status, th)} ${th.fg("accent", agentLabel)} ▸ ${th.fg("muted", model)} • ${th.fg("muted", status)} • ${(elapsedMs / 1000).toFixed(1)}s${usageStr}`;

// after — glyph via activityGlyph, elapsed via RunView.elapsedMs (frozen once terminal)
const { icon, color } = activityGlyph(status);
const head = `${th.fg(color, icon)} ${th.fg("accent", agentLabel)} ▸ ${th.fg("muted", model)} • ${th.fg("muted", status)} • ${fmtElapsed(elapsedMs)}${usageStr}`;
```

Same shape at `:535-539`: `r.status`/`r.elapsedMs` raw reads become view fields where the row is live, and the header line adopts `fmtElapsed`. Where a plain (theme-free) header line is wanted (batch child rows), use `runHeader(v)` verbatim; where a badge column is wanted, `renderBadge(v, th)` (empty string when no `badgeText`).

- [ ] **Step 3: Delete followGlyph (~:664)**

Delete the whole `function followGlyph(status: string, th: Theme): string` switch (running ● / completed ✓ / done ✓ / failed ✗ / timedout ⏱ / budget ⛔ / turns …). Every call site now goes through `activityGlyph(status)` from the barrel — which is the canonical glyph table (Global Constraint (b/c): one glyph impl, `ActivityStatus` vocabulary only). Grep proof:

```bash
grep -n "followGlyph" bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts
```
Expected: no output.

- [ ] **Step 4: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
Expected: PASS — 56 viewer tests adapted in Step 1; visual deltas only where the old switch disagreed with `activityGlyph` ("completed" case is gone per Part 1 Task 8's coercion delete).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts
git commit -m "refactor(subagent): viewer adopts runHeader/renderBadge/activityGlyph, getRunning returns RunView[], deletes followGlyph (C1)"
```

---

### Task 12: subagent-context-widget.ts — renderRun takes RunView, kills the LAST unfrozen elapsed site (Wave 2)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts:125` (`renderRun(r: InFlightSubagent)` → `renderRun(v: RunView)`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts:240` and `:260` (`registry.list()` → `registry.views()` — rides Part 1 Task 6)
- Test: `bun-apps/pi-agent-ext-subagent/tests/install-subagent-context-widget.test.ts` (already view-migrated by Part 1 Task 7)

**Interfaces:**
- Consumes: `RunView` (`agent`, `modelSeg`, `latestAction`, `elapsedMs` + `elapsedFrozen`, `badgeText`), `registry.views(opts?)`, `renderRunRow(v, theme)`.
- Produces: `renderRun(v: RunView): string[]`; the widget no longer hand-assembles agent/model/resolvedModel/fellBack from raw run fields. **This closes the PR-#1313 bug class** — the widget's tick-rendered `Date.now() - startedAt` is the LAST unfrozen elapsed computation in the repo; after this task every elapsed shown anywhere is `RunView.elapsedMs` (frozen-at-terminal by `buildRunView`).

**DEPENDS ON Part 1 Tasks 6 + 7.**

- [ ] **Step 1: Retype renderRun (test-first)**

```ts
// before (~:125)
private renderRun(r: InFlightSubagent, theme: Theme): string[] {
  if (r.agent === "workflow") { ... r.taskPreview ... }
  // ... hand-assembled resolvedModel / fellBack / elapsed math ...
}

// after
private renderRun(v: RunView, theme: Theme): string[] {
  if (v.actor === "workflow") {
    // workflow runs keep their bespoke header; taskPreview encoding now arrives as v.latestAction
    ...
  }
  // shared surfaces: renderRunRow(v, theme) for the one-line row; the expanded
  // trace keeps formatSubagentTrace but reads v.history / v.modelSeg / fmtElapsed(v.elapsedMs)
  ...
}
```

Field map: `r.agent` → `v.actor`; `r.taskPreview` → `v.latestAction`; `resolvedModel`/`fellBack` → `v.modelSeg` (+ `v.badgeText === "fallback"` when a badge is needed); any `Date.now() - startedAt` → `v.elapsedMs` (already frozen once terminal). Where the collapsed row fits, delegate wholesale to `renderRunRow(v, theme)` instead of re-composing.

- [ ] **Step 2: list() → views() at :240/:260 (rides Part 1 Task 6)**

`:240`: `new SubagentContextWidget({ getRunning: () => opts.registry.list() })` → `opts.registry.views()`. `:260` idle-churn guard: `if (!opts.registry.list().some((r) => !r.foreground)) return;` → `if (opts.registry.views({ foreground: false }).length === 0) return;` (identical semantics — `views({ foreground: false })` returns exactly the background runs). If Part 1 Task 6 already touched these lines, just verify — do not double-edit.

- [ ] **Step 3: Grep proof — no unfrozen elapsed remains in the widget**

```bash
grep -n "Date.now()\|startedAt" bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts
```
Expected: no elapsed computation (a bare `startedAt` pass-through inside a RunView-shaped object in tests is fine; production render code must show none).

- [ ] **Step 4: Run the gates**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run test )` — Expected: PASS.
Run: `( cd bun-apps/pi-agent-ext-obsidian && bunx tsc --noEmit )` — Expected: PASS (the obsidian `subagent.ts` shim must not surface `InFlightSubagent` reads of the widget; Part 1 Task 7 already checked it).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts bun-apps/pi-agent-ext-subagent/tests/install-subagent-context-widget.test.ts
git commit -m "refactor(subagent): context widget renders RunView — last unfrozen elapsed site gone (PR-1313 class, C1)"
```

---

### Task 13: workflow side — task-panel/workflow-commands/workflow-ui/display on fmtElapsed/fmtCost/activityGlyph (Wave 2)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/task-panel.ts:85` and `:191` (elapsed `toFixed(1)` → `fmtElapsed`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/task-panel.ts:405` (cost `toFixed(2/4)` ternary → `fmtCost`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts:92-97` (`renderPersistedStatus` agent glyph ternary — the THIRD glyph impl: done ✓ / error ✗ / running ◆ → `activityGlyph`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts:101` and `:118` (duration `toFixed(1)` → `fmtElapsed`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts:397` (cost `toFixed(4)` → `fmtCost`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/display.ts:221` (cost `toFixed(4)` → `fmtCost`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts` + existing suites (expected strings unchanged — formats are byte-identical)

**Interfaces:**
- Consumes: `fmtElapsed(ms): string`, `fmtCost(cost): string` (2 decimals ≥ $0.01, else 4 — exactly the `:405` comment's policy), `activityGlyph(status: ActivityStatus): { icon, color }`, `renderBadge(v, theme)` — all from `@repo/pi-agent-ext-core-runtime` (already the barrel these files import display symbols from after Part 1 Task 1's shim sweep).
- Produces: no `toFixed(1)` elapsed, no `toFixed(4)` cost, and no glyph switch/ternary in `pi-agent-ext-workflow/src` outside core-runtime.

- [ ] **Step 1: task-panel.ts — elapsed + cost**

```ts
// before (:85, :191)
const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
// after
const duration = run.result?.durationMs ? ` · ${fmtElapsed(run.result.durationMs)}` : "";

// before (:405)
usage?.cost ? `$${usage.cost.toFixed(usage.cost >= 0.01 ? 2 : 4)}` : "",
// after — fmtCost is that exact policy, shared
usage?.cost ? `$${fmtCost(usage.cost)}` : "",
```

(Delete the now-stale `2 decimals for ≥1¢…` comment at `:403-404` — the policy's one home is `fmtCost` in core-runtime.)

- [ ] **Step 2: workflow-commands.ts — glyph + duration**

```ts
// before (:94-96) — third glyph impl
const icon =
  agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
// after
const { icon } = activityGlyph(agent.status);

// before (:101, :118)
if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
// after
if (run.durationMs) lines.push(`  duration: ${fmtElapsed(run.durationMs)}`);
```

`renderPersistedStatus` is theme-free plain-text output — use the plain icon (`activityGlyph(...).icon`); where a themed badge column exists, prefer `renderBadge(v, theme)` (this is its adoption site if a `RunView` is in hand; plain persisted runs are not RunViews, so icon-only is correct here). Note `renderBadge`/`runHeader` are already exercised by subagent adoption (Task 11); this task's obligation is the glyph ternary + durations.

- [ ] **Step 3: workflow-ui.ts + display.ts — cost**

```ts
// before (workflow-ui.ts :397)
r.cost > 0 ? `$${r.cost.toFixed(4)}` : ""
// after
r.cost > 0 ? `$${fmtCost(r.cost)}` : ""

// before (display.ts :221)
const costInfo = usage?.cost ? ` · $${usage.cost.toFixed(4)}` : "";
// after
const costInfo = usage?.cost ? ` · $${fmtCost(usage.cost)}` : "";
```

(Byte-level note: for costs ≥ $0.01 the output changes from `toFixed(4)` to 2 decimals — e.g. `$0.1234` → `$0.12`. Update any test fixture asserting a 4-decimal ≥1¢ string; sub-cent values are unchanged. This convergence is the point: one cost format everywhere.)

- [ ] **Step 4: Run the gate**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS (fix any ≥1¢ 4-decimal fixture per the note above).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/task-panel.ts bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts
git commit -m "refactor(workflow): elapsed/cost/glyph on core-runtime fmtElapsed/fmtCost/activityGlyph (C1)"
```

---

### Task 14: Closer — dead-helper sweep + ALL gates (Wave 2)

**Files:**
- Verify-only across `bun-apps/pi-agent-ext-{core-runtime,subagent,workflow}` (no source edits expected; if a helper is now dead, delete it in this task)

**Interfaces:**
- Consumes: everything from Tasks 9–13.
- Produces: repo-wide invariant — every render surface is on RunView + the shared display language. C1 AgentRow convergence complete.

- [ ] **Step 1: Grep proof — no stray toFixed copies outside core-runtime**

Run:

```bash
grep -rn "toFixed(1)\|toFixed(4)" bun-apps/pi-agent-ext-core-runtime/src bun-apps/pi-agent-ext-subagent/src bun-apps/pi-agent-ext-workflow/src
```

Expected: hits ONLY inside `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` (the single home of `fmtElapsed`/`fmtCost`), or none at all. Any hit elsewhere is a missed Task 9–13 site — fix it before proceeding.

- [ ] **Step 2: Grep proof — one glyph impl, no per-site model-seg ternaries**

```bash
grep -rn "fellBack ?\|→ \${shortModel\|STATUS_ICON\[" bun-apps/pi-agent-ext-subagent/src bun-apps/pi-agent-ext-workflow/src
```

Expected: no per-site fallback/model-seg ternaries in render code (history/diagnostic formatting outside render paths is out of scope; judge case by case against Constraint (b)).

- [ ] **Step 3: Run ALL gates**

```bash
( cd bun-apps/pi-agent-ext-core-runtime && bun run test )
( cd bun-apps/pi-agent-ext-subagent && bun run test )
( cd bun-apps/pi-agent-ext-workflow && bun run test )
( cd bun-apps/pi-agent-ext-obsidian && bunx tsc --noEmit )
( cd bun-apps && bun test tests/seam-contract.test.ts tests/adr-citation.test.ts )
```

Expected: ALL PASS.

- [ ] **Step 4: Commit (wave closer)**

```bash
git add -A bun-apps/pi-agent-ext-core-runtime bun-apps/pi-agent-ext-subagent bun-apps/pi-agent-ext-workflow
git commit -m "refactor(render): all render surfaces on RunView — C1 AgentRow convergence complete"
```

---

## Part 2 completion criteria

- Tasks 9–14 all checked; every gate in Task 14 Step 3 green on the final commit.
- `fmtElapsed`/`fmtCost`/`activityGlyph`/`runHeader`/`renderBadge`/`renderRunRow` each have production callers (Wave 2 was their adoption).
- Zero `toFixed(1)`/`toFixed(4)` outside `agent-row-display.ts`; zero unfrozen elapsed computations anywhere (PR-#1313 class extinct); one glyph implementation repo-wide.
