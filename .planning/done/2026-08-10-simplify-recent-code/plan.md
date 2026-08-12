# Simplify workflow.ts — Phase 2 extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `src/workflow.ts` from 1398 to ~600 lines with zero behavior change by (2a) lifting the pure script-parser and timeout helpers into sibling modules and (2b) converting the inline stdlib/runtime closures into `createStdlib({agent, parallel})` and `createRuntime(deps)` factories so `runWorkflow` becomes orchestration-only.

**Architecture:** 2a moves the pure parser (~175 lines: `type AnyNode`, `DETERMINISM_BLOCKLIST`, `describeLeadingStatement`, `parseWorkflowScript`, `evaluateLiteral`, `propertyKey`, `validateMeta`) and the self-contained timeout helpers (~120 lines: `createLimiter`, `runAgentWithTimeout`) into `workflow-script-parser.ts` and `workflow-timeout.ts` as mechanical moves. 2b introduces two factories in `workflow-stdlib.ts` and `workflow-runtime.ts`: `createStdlib` returns {verify,judgePanel,loopUntilDry,completenessCheck,retry,gate} from deps {agent, parallel} (with new `parallelAgents`/`attemptLoop` dedup helpers), and `createRuntime` returns the heavy closures {log,phase,budget,throwIfAborted,agent,parallel,pipeline,workflowFn,checkpoint,call} from a deps bag of the captured runtime state. Pure runtime-only helpers (`defaultAgentLabel`, `hashAgentCall`, `hashCheckpoint`, `buildAgentInstructions`, `isEmptyTextAgentResult`, `estimateTokens`, `normalizeAgentRetries`) move into `workflow-runtime.ts` so value imports flow `workflow.ts → siblings` only (no runtime cycle). `workflow.ts` re-exports the moved public symbols.

**Tech Stack:** TypeScript (`bunx tsc`), Biome, `bun test`; package `bun-apps/pi-agent-ext-workflow`; acorn AST + node:vm.

## Global Constraints
- Behavior-preserving: ZERO behavior change; the existing test suite (53 files / ~18.6k lines) is the contract.
- No public API change: `src/workflow.ts` MUST re-export moved symbols so `src/index.ts` and all importers (`workflow-pack.ts`, `workflow-manager.ts`, `workflow-tool.ts`, `saved-commands.ts`, `builtin-commands.ts`) stay byte-identical. Re-exports required: `export { parseWorkflowScript } from "./workflow-script-parser.js";` and `export { createLimiter, runAgentWithTimeout } from "./workflow-timeout.js";`.
- Per-task gate (must be green before every commit): `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`. This package has NO `typecheck` script — `bun run build` (= `bunx tsc`) IS the typecheck; `bun run check` = Biome. Run `bun run check` once per task too.
- No snapshot regeneration. (No `*.snap` / toMatchSnapshot exists today; do not introduce any.)
- `defaultAgentLabel`'s `phase` default is LIVE (reachable for phase-less scripts) — do NOT delete or alter it. (Phase 1 is deferred; moot here.)
- Phase 1 (per-package dedup/dead-code) is DEFERRED — this plan covers Phase 2 ONLY.
- `import type` discipline: `bun-apps/pi-agent-ext-workflow/tsconfig.json` has `verbatimModuleSyntax` OFF (confirmed: `target` ES2022, `module`/`moduleResolution` NodeNext, `strict`, `noUncheckedIndexedAccess`, `declaration`; no `verbatimModuleSyntax`). Even though it is off, ALL type-only imports from `./workflow.js` into the new sibling modules MUST use `import type` (good discipline + erased at runtime). Value imports flow `workflow.ts → siblings` only: no sibling module may value-import from `./workflow.js`. `workflow-runtime.ts` imports `runAgentWithTimeout` from `./workflow-timeout.js` (value, same direction) and receives `runWorkflow` via the deps bag (injection) instead of back-importing it.
- Import-direction map (verified, no cycles): `workflow.ts` value-imports from {`./workflow-script-parser.js`, `./workflow-timeout.js`, `./workflow-stdlib.js`, `./workflow-runtime.js`}; `workflow-stdlib.ts` imports only types from `./workflow.js` + value `WorkflowErrorCode` from `@repo/pi-agent-ext-subagent`; `workflow-runtime.ts` value-imports `runAgentWithTimeout` from `./workflow-timeout.js`, `buildCallGlobal` from `./call-global.js`, `resolveModelForPhase` from `./model-routing.js`, subagent values, and types from `./workflow.js`.

---

### Task 1: Extract pure script parser into `workflow-script-parser.ts` (2a, mechanical)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/workflow-script-parser.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (remove lines 250, 253, 1055-1080, 1082-1167, 1169-1205, 1207-1212, 1214-1229; remove the now-unused acorn imports; add import + re-export for `parseWorkflowScript`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-parser.test.ts`

**Interfaces:**
- Consumes: `WorkflowMeta` (workflow.ts:36-42), `WorkflowMetaPhase` (workflow.ts:30-34) as types; `WorkflowError`, `WorkflowErrorCode` values from `@repo/pi-agent-ext-subagent`; acorn `Node` type + `parse` value.
- Produces: `export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string; defaultExport?: string }` (same signature, now sourced from `workflow-script-parser.ts` and re-exported by `workflow.ts`).

- [ ] **Step 1: Create `src/workflow-script-parser.ts` with the relocated pure parser.**
Create the file with exactly these contents (relocate verbatim from `workflow.ts`: `type AnyNode` line 250, `DETERMINISM_BLOCKLIST` line 253, `describeLeadingStatement` lines 1055-1080, `parseWorkflowScript` lines 1082-1167, `evaluateLiteral` lines 1169-1205, `propertyKey` lines 1207-1212, `validateMeta` lines 1214-1229):

```ts
import type { Node } from "acorn";
import { parse } from "acorn";
import { WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-subagent";
import type { WorkflowMeta, WorkflowMetaPhase } from "./workflow.js";

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Describes the offending first statement for the "meta must be first" error, so
 * the message is self-diagnosing instead of a bare "must be the first statement".
 * Returns a short noun phrase + a quoted source snippet, e.g.
 *   "a `const` declaration: `const helper = makeHelper()`"
 *   "an `import` statement (imports are not allowed — workflows must be self-contained): `import fs from 'fs'`"
 * Comments/blank lines never reach here (acorn excludes them from `body`).
 */
function describeLeadingStatement(node: AnyNode | undefined, script: string): string {
  // … body relocated verbatim from workflow.ts lines 1056-1079 …
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string; defaultExport?: string } {
  // … body relocated verbatim from workflow.ts lines 1083-1166 …
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  // … body relocated verbatim from workflow.ts lines 1170-1204 …
}

function propertyKey(node: AnyNode, path: string): string {
  // … body relocated verbatim from workflow.ts lines 1208-1211 …
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  // … body relocated verbatim from workflow.ts lines 1215-1228 …
}
```

Relocate each body byte-for-byte from the cited line ranges (do not edit logic). `DETERMINISM_PRELUDE` (workflow.ts:268-285) STAYS in `workflow.ts` — it is used only by `runWorkflow` orchestration (lines 1022-1023), not by the parser. `WorkflowMeta`/`WorkflowMetaPhase` STAY defined in `workflow.ts` (also consumed by `display.ts:21` and re-exported by `index.ts`); the parser imports them as types only.

- [ ] **Step 2: Remove the parser declarations from `workflow.ts` and wire the re-export.**
In `src/workflow.ts`:
- Delete the `type AnyNode = …` declaration (line 250) and its preceding blank line/comment if any.
- Delete the `DETERMINISM_BLOCKLIST` const (line 253) plus its comment line 252.
- Delete `function describeLeadingStatement` (lines 1055-1080).
- Delete `export function parseWorkflowScript` (lines 1082-1167).
- Delete `function evaluateLiteral` (lines 1169-1205).
- Delete `function propertyKey` (lines 1207-1212).
- Delete `function validateMeta` (lines 1214-1229).
- Remove the now-unused acorn imports at the top: `import type { Node } from "acorn";` and `import { parse } from "acorn";` (no remaining user in `workflow.ts` — confirmed by grep).
- Keep `import type { TSchema } from "typebox";` (still used by `AgentOptions`/`isEmptyTextAgentResult`).
- Add, alongside the existing local imports (after the `./call-global.js` import block):
```ts
import { parseWorkflowScript } from "./workflow-script-parser.js";
```
- Add the required public re-export (top-level, near the other `export` statements):
```ts
export { parseWorkflowScript } from "./workflow-script-parser.js";
```
`runWorkflow`'s use at workflow.ts:292 (`const { meta, body, defaultExport } = parseWorkflowScript(script);`) now resolves to the imported binding; `index.ts`'s `export { parseWorkflowScript, runWorkflow } from "./workflow.js";` stays byte-identical.

- [ ] **Step 3: Verify the parser gate is green.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test tests/workflow-parser.test.ts && bun run check )`
Expected: `bunx tsc` emits `dist/` with no errors; `workflow-parser.test.ts` passes (it imports `parseWorkflowScript` from `../src/workflow.js`, which now re-exports from the parser); Biome reports no errors.

- [ ] **Step 4: Run the full gate.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass. No behavior change.

- [ ] **Step 5: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-script-parser.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): extract script parser into workflow-script-parser.ts"
```

---

### Task 2: Extract timeout helpers into `workflow-timeout.ts` (2a, mechanical)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/workflow-timeout.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (remove `createLimiter` lines 1231-1247 and `runAgentWithTimeout` lines 1344-1398; add import + re-export)
- Test: `bun-apps/pi-agent-ext-workflow/tests/agent.test.ts`, `tests/workflow-runtime.test.ts`, `tests/regression-rca.test.ts`

**Interfaces:**
- Consumes: `WorkflowError`, `WorkflowErrorCode` values from `@repo/pi-agent-ext-subagent`.
- Produces: `export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T>` and `export async function runAgentWithTimeout<T>(runFn: (signal: AbortSignal | undefined) => Promise<T>, timeoutMs: number | null, parentSignal: AbortSignal | undefined, label: string): Promise<T>` (both now sourced from `workflow-timeout.ts` and re-exported by `workflow.ts`).

- [ ] **Step 1: Create `src/workflow-timeout.ts` with the two relocated helpers.**
Create the file with exactly these contents (relocate verbatim from `workflow.ts`: `createLimiter` lines 1231-1247, `runAgentWithTimeout` lines 1344-1398):

```ts
import { WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-subagent";

export function createLimiter(limit: number) {
  // … body relocated verbatim from workflow.ts lines 1232-1246 …
}

export async function runAgentWithTimeout<T>(
  runFn: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | null,
  parentSignal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  // … body relocated verbatim from workflow.ts lines 1345-1397 …
}
```

Relocate each body byte-for-byte from the cited ranges (do not edit logic). `runAgentWithTimeout` uses `WorkflowError` + `WorkflowErrorCode` only; `createLimiter` uses nothing external — both are self-contained (confirmed by reading lines 1231-1247 and 1344-1398).

- [ ] **Step 2: Remove the helpers from `workflow.ts` and wire import + re-export.**
In `src/workflow.ts`:
- Delete `function createLimiter` (lines 1231-1247) and `async function runAgentWithTimeout` (lines 1344-1398).
- Add the local-use imports (these two are used inside `runWorkflow`: `createLimiter` at line 331 in the `shared` setup, `runAgentWithTimeout` at line 530 inside the `agent` closure):
```ts
import { createLimiter, runAgentWithTimeout } from "./workflow-timeout.js";
```
- Add the required public re-export:
```ts
export { createLimiter, runAgentWithTimeout } from "./workflow-timeout.js";
```
(The import provides the local binding for lines 331/530; the re-export satisfies the public-surface constraint. `runAgentWithTimeout` and `createLimiter` are currently internal-only — no external importer — but the constraint requires the re-export.)

- [ ] **Step 3: Verify the timeout-touching tests are green.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test tests/agent.test.ts tests/workflow-runtime.test.ts tests/regression-rca.test.ts && bun run check )`
Expected: build clean; the three named suites pass (they exercise timeout + limiter paths); Biome clean.

- [ ] **Step 4: Run the full gate.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass.

- [ ] **Step 5: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-timeout.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): extract timeout helpers into workflow-timeout.ts"
```

---

### Task 3: Add `parallelAgents` + `attemptLoop` dedup helpers with unit tests (2b, TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/workflow-stdlib.ts`
- Create: `bun-apps/pi-agent-ext-workflow/tests/workflow-stdlib.test.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (add three exported type aliases `AgentFn`/`ParallelFn`/`PipelineFn`; add `export` to `RuntimeState` at line 222)

**Interfaces:**
- Consumes: `AgentOptions` (workflow.ts:160-203), `TSchema` (typebox), `RuntimeState` (workflow.ts:222-248).
- Produces:
  - `export type AgentFn = (prompt: string, agentOptions?: AgentOptions) => Promise<unknown>;`
  - `export type ParallelFn = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;`
  - `export type PipelineFn = (items: unknown[], ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>) => Promise<unknown[]>;`
  - `export interface StdlibDeps { agent: AgentFn; parallel: ParallelFn; }`
  - `export interface Stdlib { verify; judgePanel; loopUntilDry; completenessCheck; retry; gate; }` (full shapes below — interface declared now; `createStdlib` body lands in Task 4)
  - `export async function parallelAgents(parallel: ParallelFn, agent: AgentFn, count: number, labelPrefix: string, promptBuilder: (i: number) => string, schema: TSchema): Promise<unknown[]>;`
  - `export async function attemptLoop(maxAttempts: number, body: (i: number) => Promise<{ done: boolean; value?: unknown }>): Promise<unknown>;`

- [ ] **Step 1: Write the failing unit test first (TDD).**
Create `tests/workflow-stdlib.test.ts`:
```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { attemptLoop, parallelAgents } from "../src/workflow-stdlib.js";

test("attemptLoop returns the value when body signals done before maxAttempts", async () => {
  const seen: number[] = [];
  const out = await attemptLoop(5, async (i) => {
    seen.push(i);
    return { done: i === 2, value: `done@${i}` };
  });
  assert.equal(out, "done@2");
  assert.deepEqual(seen, [0, 1, 2]);
});

test("attemptLoop returns the last value when maxAttempts is exhausted (never done)", async () => {
  const seen: number[] = [];
  const out = await attemptLoop(3, async (i) => {
    seen.push(i);
    return { done: false, value: `try@${i}` };
  });
  assert.equal(out, "try@2");
  assert.deepEqual(seen, [0, 1, 2]);
});

test("parallelAgents fans out count agents labelled `${labelPrefix} ${i+1}` passing schema", async () => {
  const labels: string[] = [];
  const prompts: string[] = [];
  const markerSchema = { type: "object", properties: { ok: { type: "boolean" } } } as unknown as import("typebox").TSchema;
  const fakeAgent = async (prompt: string, opts?: { label?: string; schema?: unknown }) => {
    if (opts?.label) labels.push(opts.label);
    prompts.push(prompt);
    assert.equal(opts?.schema, markerSchema, "schema is forwarded unchanged");
    return { ok: true, prompt, label: opts?.label };
  };
  const fakeParallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  const results = await parallelAgents(
    fakeParallel as any,
    fakeAgent as any,
    3,
    "verify",
    (i) => `q${i}`,
    markerSchema,
  );
  assert.equal(results.length, 3);
  assert.deepEqual(labels, ["verify 1", "verify 2", "verify 3"]);
  assert.deepEqual(prompts, ["q0", "q1", "q2"]);
});
```
Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-stdlib.test.ts )`
Expected: FAIL — module `../src/workflow-stdlib.js` does not exist yet.

- [ ] **Step 2: Add the shared closure type aliases to `workflow.ts` and export `RuntimeState`.**
In `src/workflow.ts`, immediately after the `AgentOptions` interface (ends line 203) and before `CheckpointOptions`, add:
```ts
/** agent() global signature shared between runWorkflow, createStdlib, and createRuntime. */
export type AgentFn = (prompt: string, agentOptions?: AgentOptions) => Promise<unknown>;
/** parallel() global signature shared between runWorkflow, createStdlib, and createRuntime. */
export type ParallelFn = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
/** pipeline() global signature shared between runWorkflow and createRuntime. */
export type PipelineFn = (
  items: unknown[],
  ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
) => Promise<unknown[]>;
```
Change `interface RuntimeState {` at line 222 to `export interface RuntimeState {` (exported now; `createRuntime` in Task 5 imports it as a type).

- [ ] **Step 3: Implement the helpers + interfaces in `workflow-stdlib.ts` (minimal pass).**
Create `src/workflow-stdlib.ts`:
```ts
import type { TSchema } from "typebox";
import type { AgentFn, ParallelFn } from "./workflow.js";

export interface StdlibDeps {
  agent: AgentFn;
  parallel: ParallelFn;
}

export interface Stdlib {
  verify: (
    item: unknown,
    opts?: { reviewers?: number; threshold?: number; lens?: string | string[] },
  ) => Promise<{
    real: boolean;
    realCount: number;
    total: number;
    requested: number;
    failed: number;
    votes: Array<{ real?: boolean; reason?: string }>;
  }>;
  judgePanel: (
    attempts: unknown[],
    opts?: { judges?: number; rubric?: string },
  ) => Promise<{ index: number; attempt: unknown; score: number | undefined; judgments: unknown[] } | undefined>;
  loopUntilDry: (opts: {
    round: (i: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => Promise<unknown[] & { truncated?: true }>;
  completenessCheck: (taskArgs: unknown, results: unknown) => Promise<unknown>;
  retry: (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts?: { attempts?: number; until?: (r: unknown) => boolean },
  ) => Promise<unknown>;
  gate: (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts?: { attempts?: number },
  ) => Promise<{ ok: boolean; value: unknown; attempts: number }>;
}

/**
 * Fan out `count` agent() calls through `parallel`, labelling each
 * `${labelPrefix} ${i+1}` and forwarding one shared `schema`. Dedup target for
 * verify()/judgePanel(), which both spelled this `Array.from({length:n}, ...)` pattern inline.
 */
export async function parallelAgents(
  parallel: ParallelFn,
  agent: AgentFn,
  count: number,
  labelPrefix: string,
  promptBuilder: (i: number) => string,
  schema: TSchema,
): Promise<unknown[]> {
  return parallel(
    Array.from({ length: count }, (_v, i) => () =>
      agent(promptBuilder(i), { label: `${labelPrefix} ${i + 1}`, schema }),
    ),
  );
}

/**
 * Bounded `for i in attempts` loop. Calls `body(i)` until it returns `{ done: true }`
 * (returning that `value`) or `maxAttempts` is reached (returning the last `value`).
 * Dedup target for retry()/gate(), which both spelled this bounded-loop pattern inline.
 */
export async function attemptLoop(
  maxAttempts: number,
  body: (i: number) => Promise<{ done: boolean; value?: unknown }>,
): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const r = await body(i);
    last = r.value;
    if (r.done) return r.value;
  }
  return last;
}
```

- [ ] **Step 4: Verify the new tests pass.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-stdlib.test.ts )`
Expected: 3 tests PASS. `attemptLoop` returns the done value or the last value; `parallelAgents` produces N results with the right labels + forwarded schema.

- [ ] **Step 5: Run the full gate (nothing else changed).**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test && bun run check )`
Expected: all 53 test files pass; build clean; Biome clean. (`workflow.ts` only gained three type aliases + one `export` keyword — no runtime behavior change.)

- [ ] **Step 6: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-stdlib.ts bun-apps/pi-agent-ext-workflow/tests/workflow-stdlib.test.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): add parallelAgents/attemptLoop dedup helpers + shared closure types"
```

---

### Task 4: Implement `createStdlib` factory and wire `runWorkflow` to use it (2b)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-stdlib.ts` (add `createStdlib` + move the three schema consts in)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (remove the six inline stdlib closures + three schema consts at lines 726-917; replace with `createStdlib({ agent, parallel })`; update the vm context at 986-1019 to reference `stdlib.*`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/quality-stdlib.test.ts`, `tests/regression-rca.test.ts`, `tests/workflow-tool-pack.test.ts`, `tests/workflow-runtime.test.ts`

**Interfaces:**
- Consumes: `parallelAgents`, `attemptLoop`, `Stdlib`, `StdlibDeps` (Task 3); `WorkflowErrorCode` value from `@repo/pi-agent-ext-subagent`; the inline closures at workflow.ts:726-917 (the bodies to relocate). `verify` (731-765) and `judgePanel` (771-820) currently each spell `parallel(Array.from({length:n}, (_v,i)=>()=>agent(promptBuilder(i), {label:`${prefix} ${i+1}`, schema})))` — this is replaced by `parallelAgents`. `retry` (884-895) and `gate` (896-917) currently each spell a bounded `for i in attempts` loop — replaced by `attemptLoop`. `loopUntilDry` (821-867) and `completenessCheck` (873-883) move unchanged.
- Produces: `export function createStdlib(deps: StdlibDeps): Stdlib;` — returns `{ verify, judgePanel, loopUntilDry, completenessCheck, retry, gate }`. `runWorkflow` no longer defines these six inline.

- [ ] **Step 1: Add `createStdlib` to `workflow-stdlib.ts` (move the six closures + schemas in, applying the two dedups).**
Append to `src/workflow-stdlib.ts` (add the `WorkflowErrorCode` value import at the top: `import { WorkflowErrorCode } from "@repo/pi-agent-ext-subagent";`):

```ts
import { WorkflowErrorCode } from "@repo/pi-agent-ext-subagent";

const VERIFY_SCHEMA = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
};
const JUDGE_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" }, reason: { type: "string" } },
  required: ["score"],
};
const COMPLETENESS_SCHEMA = {
  type: "object",
  properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
  required: ["complete"],
};

export function createStdlib(deps: StdlibDeps): Stdlib {
  const { agent, parallel } = deps;

  const verify: Stdlib["verify"] = async (item, opts = {}) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallelAgents(
        parallel,
        agent,
        reviewers,
        "verify",
        (i) =>
          `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
        VERIFY_SCHEMA as unknown as TSchema,
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      requested: reviewers,
      failed: reviewers - votes.length,
      votes,
    };
  };

  const judgePanel: Stdlib["judgePanel"] = async (attempts, opts = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallelAgents(
              parallel,
              agent,
              judges,
              `judge ${idx + 1}`,
              () =>
                `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
              JUDGE_SCHEMA as unknown as TSchema,
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : undefined;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number | undefined; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index. A candidate whose
    // judges ALL failed has score === undefined (unscored) — do not rank it above
    // any scored candidate (RCA#7). When every candidate is unscored, return the first.
    let best: (typeof scored)[0] | undefined;
    let bestScore: number | undefined;
    let bestIndex: number | undefined;
    for (const s of scored) {
      if (s.score === undefined) continue;
      if (bestScore === undefined || s.score > bestScore || (s.score === bestScore && s.index < (bestIndex ?? Infinity))) {
        best = s;
        bestScore = s.score;
        bestIndex = s.index;
      }
    }
    best ??= scored[0];
    return best;
  };

  // loopUntilDry + completenessCheck relocated UNCHANGED from workflow.ts:821-867 and 873-883.
  const loopUntilDry: Stdlib["loopUntilDry"] = async (opts) => {
    // … body relocated verbatim from workflow.ts lines 822-866 …
  };
  const completenessCheck: Stdlib["completenessCheck"] = (taskArgs, results) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA as unknown as TSchema },
    );

  // retry + gate now use attemptLoop; bodies otherwise unchanged from workflow.ts:884-917.
  const retry: Stdlib["retry"] = async (thunk, opts = {}) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    return attemptLoop(attempts, async (i) => {
      const last = await thunk(i);
      return { done: !opts.until || opts.until(last), value: last };
    });
  };
  const gate: Stdlib["gate"] = async (thunk, validator, opts = {}) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    const out = await attemptLoop(attempts, async (i) => {
      const last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { done: true, value: { ok: true, value: last, attempts: i + 1 } };
      feedback = verdict?.feedback;
      return { done: false, value: { ok: false, value: last, attempts: i + 1 } };
    });
    return out as { ok: boolean; value: unknown; attempts: number };
  };

  return { verify, judgePanel, loopUntilDry, completenessCheck, retry, gate };
}
```

Relocate the `loopUntilDry` body (workflow.ts:822-866) verbatim — it references `WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED` and `WorkflowErrorCode.AGENT_LIMIT_EXCEEDED` (now satisfied by the new value import) and `opts.round`/`opts.key`/`opts.consecutiveEmpty`/`opts.maxRounds`. Note: the dedup preserves behavior exactly — `verify`/`judgePanel` produce the identical `parallel(...)` fan-out (same label format `${prefix} ${i+1}`, same schema, same N) via `parallelAgents`; `retry`/`gate` produce the identical bounded loop via `attemptLoop` (same attempt count semantics, same return-the-last-value behavior).

- [ ] **Step 2: Remove the inline stdlib closures from `workflow.ts` and wire `createStdlib`.**
In `src/workflow.ts`:
- Delete the six closures + three schema consts at lines 726-917: `VERIFY_SCHEMA` (726-730), `verify` (731-765), `JUDGE_SCHEMA` (766-770), `judgePanel` (771-820), `loopUntilDry` (821-867), `COMPLETENESS_SCHEMA` (868-872), `completenessCheck` (873-883), `retry` (884-895), `gate` (896-917).
- Add the local-use import near the other sibling imports:
```ts
import { createStdlib } from "./workflow-stdlib.js";
```
- Immediately AFTER the `agent` (ends line 630) and `parallel` (631-660) closures are defined (these stay inline until Task 5), insert:
```ts
  const stdlib = createStdlib({ agent, parallel });
```
- Update the vm context (lines 986-1019): replace the six bare references with `stdlib.*`. The `agent`, `parallel`, `pipeline`, `workflow: workflowFn`, `checkpoint`, `call`, `log`, `phase`, `budget`, `console` keys stay inline (they move in Tasks 5/6); only the six stdlib globals change:
```ts
  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify: stdlib.verify,
    judgePanel: stdlib.judgePanel,
    loopUntilDry: stdlib.loopUntilDry,
    completenessCheck: stdlib.completenessCheck,
    retry: stdlib.retry,
    gate: stdlib.gate,
    checkpoint,
    call,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
  });
```
- [ ] **Step 3: Verify the stdlib-touching tests are green.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test tests/quality-stdlib.test.ts tests/regression-rca.test.ts tests/workflow-tool-pack.test.ts tests/workflow-runtime.test.ts && bun run check )`
Expected: build clean; `quality-stdlib.test.ts` (verify/judgePanel/loopUntilDry/retry/gate via `runWorkflow`) passes; the regression + runtime suites pass; Biome clean.

- [ ] **Step 4: Run the full gate.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass. The six globals resolve to `stdlib.*` inside the vm; behavior is byte-identical.

- [ ] **Step 5: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-stdlib.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): implement createStdlib factory and dedup verify/judgePanel/retry/gate"
```

---

### Task 5: Create `createRuntime` core in `workflow-runtime.ts` — move leaf closures + parallel + pipeline + agent (2b, highest risk)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/workflow-runtime.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (move `log` 351-356, `phase` 357-368, `budget` 369-374, `throwIfAborted` 375-380, `agent` 381-630, `parallel` 631-660, `pipeline` 662-691 out; remove the relocated pure helpers `defaultAgentLabel` 1249-1251, `hashAgentCall` 1263-1290, `hashCheckpoint` 1254-1261, `buildAgentInstructions` 1292-1309, `isEmptyTextAgentResult` 1311-1313, `estimateTokens` 1315-1317, `normalizeAgentRetries` 1324-1327; re-export `hashAgentCall`; replace closures with `const rt = createRuntime({...})`; update `createStdlib` call + vm context + orchestration `log(...)` → `rt.log(...)`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/agent.test.ts`, `tests/workflow-runtime.test.ts`, `tests/workflow-manager.test.ts`, `tests/call-global.test.ts`, `tests/call-integration.test.ts`, `tests/run-persistence.test.ts`, `tests/regression-rca.test.ts`

**Interfaces:**
- Consumes (types from `./workflow.js`): `RuntimeState` (now exported, workflow.ts:222), `SharedRuntime` (workflow.ts:59), `WorkflowRunOptions` (workflow.ts:67), `WorkflowRunResult` (workflow.ts:142), `AgentOptions` (workflow.ts:160), `CheckpointOptions` (workflow.ts:203), `AgentFn`/`ParallelFn`/`PipelineFn` (Task 3). Values: `runAgentWithTimeout` from `./workflow-timeout.js` (Task 2), `buildCallGlobal` from `./call-global.js` (used in Task 6 but imported now to avoid re-touching), `resolveModelForPhase` from `./model-routing.js`, and from `@repo/pi-agent-ext-subagent`: `AgentDefinition`, `AgentHistoryEntry`, `AgentRegistry`, `AgentUsage`, `SddReport` (types) + `agentDefinitionKey`, `createWorktree`, `removeWorktree`, `resolveAgentType`, `WorkflowAgent`, `WorkflowError`, `WorkflowErrorCode`, `Worktree`, `wrapError` (values). The `agent` closure body to relocate (workflow.ts:381-630).
- Produces:
  - `export interface RuntimeDeps { options: WorkflowRunOptions; shared: SharedRuntime; state: RuntimeState; agentRunner: Pick<WorkflowAgent, "run">; maxAgents: number; agentTimeoutMs: number; runId: string; baseCwd: string; agentRegistry: AgentRegistry; routingConfig: ReturnType<typeof parseModelRoutingFromMeta>; dispatch: <T>(fn: () => Promise<T>) => Promise<T>; logger: ReturnType<typeof createWorkflowLogger>; runWorkflow: (script: string, options: WorkflowRunOptions) => Promise<WorkflowRunResult>; }` (the exact canonical form shown in Step 2's code block — `parseModelRoutingFromMeta`/`createWorkflowLogger` are imported as values so `ReturnType<typeof …>` resolves).
  - `export interface Runtime { log: (message: string) => void; phase: (title: string, phaseOptions?: { budget?: number }) => void; budget: Readonly<{ total: number | null; spent: () => number; remaining: () => number }>; throwIfAborted: () => void; agent: AgentFn; parallel: ParallelFn; pipeline: PipelineFn; }` (Task 5 core subset; Task 6 adds `workflowFn`/`checkpoint`/`call`).
  - `export function createRuntime(deps: RuntimeDeps): Runtime;` (core).

- [ ] **Step 1: Baseline — confirm green before any move.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass (Task 4 state). Do not proceed if not green.

- [ ] **Step 2: Create `src/workflow-runtime.ts` with the relocated pure helpers + `RuntimeDeps`/`Runtime` (core) + `createRuntime` (core).**
Create the file. Imports (value imports flow into this module only — none from `./workflow.js` are values):
```ts
import { createHash } from "node:crypto";
import {
  type AgentDefinition,
  type AgentHistoryEntry,
  type AgentRegistry,
  type AgentUsage,
  agentDefinitionKey,
  createWorktree,
  type SddReport,
  removeWorktree,
  resolveAgentType,
  type Worktree,
  WorkflowAgent,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "@repo/pi-agent-ext-subagent";
import type { TSchema } from "typebox";
import { buildCallGlobal } from "./call-global.js";
import type { HostFnAskOptions } from "./host-fn-registry.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { runAgentWithTimeout } from "./workflow-timeout.js";
import type {
  AgentFn,
  AgentOptions,
  CheckpointOptions,
  ParallelFn,
  PipelineFn,
  RuntimeState,
  SharedRuntime,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./workflow.js";
```
Then relocate these pure helpers verbatim into this file as module-level functions (cited ranges, byte-for-byte — do NOT alter logic; `defaultAgentLabel`'s phase default stays LIVE):
- `function defaultAgentLabel(phase: string | undefined, index: number): string { … }` (from workflow.ts:1249-1251)
- `function hashCheckpoint(promptText: string, options: CheckpointOptions): string { … }` (from workflow.ts:1254-1261)
- `export function hashAgentCall(prompt: string, model: string | undefined, phase: string | undefined, options: AgentOptions, agentDefKey: string | null): string { … }` (from workflow.ts:1263-1290 — keep `export`; `tests/workflow-runtime.test.ts:5` imports it via `../src/workflow.js`, satisfied by the re-export added in Step 4)
- `function buildAgentInstructions(phase: string | undefined, options: AgentOptions, def: AgentDefinition | undefined, resolvedIsolation?: "worktree"): string | undefined { … }` (from workflow.ts:1292-1309)
- `function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean { … }` (from workflow.ts:1311-1313)
- `function estimateTokens(value: unknown): number { … }` (from workflow.ts:1315-1317)
- `function normalizeAgentRetries(value: unknown): number { … }` (from workflow.ts:1324-1327)

Then the core types + factory. The leaf closures become locals inside `createRuntime`; `agent`/`parallel`/`pipeline` close over `deps.*` instead of `runWorkflow` locals:
```ts
export interface RuntimeDeps {
  options: WorkflowRunOptions;
  shared: SharedRuntime;
  state: RuntimeState;
  agentRunner: Pick<WorkflowAgent, "run">;
  maxAgents: number;
  agentTimeoutMs: number;
  runId: string;
  baseCwd: string;
  agentRegistry: AgentRegistry;
  routingConfig: ReturnType<typeof parseModelRoutingFromMeta>;
  dispatch: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: ReturnType<typeof createWorkflowLogger>;
  /** Injected (not back-imported) so workflowFn() can recurse without a runtime cycle. */
  runWorkflow: (script: string, options: WorkflowRunOptions) => Promise<WorkflowRunResult>;
}

export interface Runtime {
  log: (message: string) => void;
  phase: (title: string, phaseOptions?: { budget?: number }) => void;
  budget: Readonly<{ total: number | null; spent: () => number; remaining: () => number }>;
  throwIfAborted: () => void;
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { options, shared, state, agentRunner, maxAgents, agentTimeoutMs, runId, baseCwd, agentRegistry, routingConfig, dispatch, logger } = deps;

  // Leaf closures relocated UNCHANGED from workflow.ts:351-380; they now close over
  // deps fields (state/logger/options/shared) instead of runWorkflow locals.
  const log = (message: string) => { /* … body from workflow.ts:352-355 … */ };
  const phase = (title: string, phaseOptions?: { budget?: number }) => { /* … from 358-367 … */ };
  const budget = Object.freeze({ /* … from 370-373 … */ });
  const throwIfAborted = () => { /* … from 376-379 … */ };

  // agent relocated from workflow.ts:381-630; every captured runWorkflow local is
  // now a deps field (options/shared/state/agentRunner/maxAgents/agentTimeoutMs/
  // runId/baseCwd/agentRegistry/routingConfig/dispatch/logger) or a local above
  // (log/throwIfAborted/budget) or a module helper. Body is byte-for-byte identical.
  const agent: AgentFn = async (prompt, agentOptions = {}) => { /* … from 382-629 … */ };

  // parallel relocated UNCHANGED from workflow.ts:631-660.
  const parallel: ParallelFn = async (thunks) => { /* … from 632-659 … */ };

  // pipeline relocated UNCHANGED from workflow.ts:662-691.
  const pipeline: PipelineFn = async (items, ...stages) => { /* … from 663-690 … */ };

  return { log, phase, budget, throwIfAborted, agent, parallel, pipeline };
}
```
Relocate each cited body byte-for-byte. Inside `agent`, the only edits are name rebinding: `options`→`options` (deps field, same name), `shared`→`shared`, `state`→`state`, `agentRunner`→`agentRunner`, `maxAgents`→`maxAgents`, `agentTimeoutMs`→`agentTimeoutMs`, `runId`→`runId`, `baseCwd`→`baseCwd`, `agentRegistry`→`agentRegistry`, `routingConfig`→`routingConfig`, `dispatch`→`dispatch`, `logger`→`logger` — all already match the destructured names, so the body needs NO textual edits. `log`/`throwIfAborted`/`budget` are now the locals above (same names). The helpers `defaultAgentLabel`/`hashAgentCall`/`buildAgentInstructions`/`isEmptyTextAgentResult`/`estimateTokens`/`normalizeAgentRetries` and `runAgentWithTimeout`/`resolveModelForPhase`/`resolveAgentType`/`agentDefinitionKey`/`createWorktree`/`removeWorktree` are module-scope imports/locals — same names, no edits.

- [ ] **Step 3: Remove the moved closures + helpers from `workflow.ts`; wire `createRuntime` + `hashAgentCall` re-export.**
In `src/workflow.ts`:
- Remove the leaf + heavy closures from `runWorkflow`: `log` (351-356), `phase` (357-368), `budget` (369-374), `throwIfAborted` (375-380), `agent` (381-630), `parallel` (631-660), `pipeline` (662-691).
- Remove the relocated pure helpers: `defaultAgentLabel` (1249-1251), `hashCheckpoint` (1254-1261), `hashAgentCall` (1263-1290), `buildAgentInstructions` (1292-1309), `isEmptyTextAgentResult` (1311-1313), `estimateTokens` (1315-1317), `normalizeAgentRetries` (1324-1327). KEEP `normalizeConcurrency` (1319-1322) — it is still used in the `runWorkflow` setup const `concurrency`.
- Remove now-unused imports from the top of `workflow.ts`: `createHash` from `node:crypto` (was used by `hashAgentCall`/`hashCheckpoint`, now in the runtime module), `agentDefinitionKey`/`createWorktree`/`resolveAgentType`/`removeWorktree`/`AgentDefinition`/`AgentHistoryEntry`/`AgentUsage`/`SddReport`/`Worktree` (now in the runtime module — confirm each with `grep -n` in `workflow.ts` before deleting; keep `WorkflowAgent`, `WorkflowError`, `WorkflowErrorCode`, `wrapError`, `loadAgentRegistry`, `providerFromModelSpec`, `getGlobalRateLimiter` which are still used in setup). KEEP `resolveModelForPhase` import if still referenced in `workflow.ts` after the move — grep first (it was used only inside `agent`; if so, remove it).
- Add the local-use import:
```ts
import { createRuntime } from "./workflow-runtime.js";
```
- Add the re-export so `tests/workflow-runtime.test.ts:5` keeps resolving `hashAgentCall` from `../src/workflow.js`:
```ts
export { hashAgentCall } from "./workflow-runtime.js";
```
- In `runWorkflow`, immediately after the setup consts (which end with `dispatch` at ~line 349), insert:
```ts
  const rt = createRuntime({ options, shared, state, agentRunner, maxAgents, agentTimeoutMs, runId, baseCwd, agentRegistry, routingConfig, dispatch, logger, runWorkflow });
```
- Update the `createStdlib` call (Task 4) to use the runtime's agent/parallel:
```ts
  const stdlib = createStdlib({ agent: rt.agent, parallel: rt.parallel });
```
- Update the vm context to route the moved closures through `rt.*` (the stdlib globals already reference `stdlib.*` from Task 4):
```ts
    agent: rt.agent,
    parallel: rt.parallel,
    pipeline: rt.pipeline,
    workflow: workflowFn,    // still inline — Task 6
    verify: stdlib.verify,
    judgePanel: stdlib.judgePanel,
    loopUntilDry: stdlib.loopUntilDry,
    completenessCheck: stdlib.completenessCheck,
    retry: stdlib.retry,
    gate: stdlib.gate,
    checkpoint,              // still inline — Task 6
    call,                    // still inline — Task 6
    log: rt.log,
    phase: rt.phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget: rt.budget,
    console: {
      log: rt.log,
      info: rt.log,
      warn: (m: unknown) => rt.log(`[warn] ${String(m)}`),
      error: (m: unknown) => rt.log(`[error] ${String(m)}`),
    },
```
- Update the one orchestration `log(...)` call after `logger.persist()` (~line 1030) to `rt.log(...)`:
```ts
  const logFile = logger.persist();
  if (logFile) {
    rt.log(`Logs persisted to ${logFile}`);
  }
```

- [ ] **Step 4: Verify the runtime-touching suites are green.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test tests/agent.test.ts tests/workflow-runtime.test.ts tests/workflow-manager.test.ts tests/call-global.test.ts tests/call-integration.test.ts tests/run-persistence.test.ts tests/regression-rca.test.ts && bun run check )`
Expected: build clean; all named suites pass (the `agent` closure is 250 lines and the riskiest move — these suites cover agent dispatch, parallel/pipeline, worktree isolation, timeout, resume journaling, and the `hashAgentCall` resume-key contract); Biome clean.

- [ ] **Step 5: Run the full gate.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass.

- [ ] **Step 6: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-runtime.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): createRuntime core — move leaf/agent/parallel/pipeline closures + helpers"
```

---

### Task 6: Extend `createRuntime` with `workflowFn` + `checkpoint` + `call`; finalize `runWorkflow` as orchestration-only; verify line target (2b)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-runtime.ts` (extend `Runtime` interface + `createRuntime` body with `workflowFn` 695-720, `checkpoint` 918-961, `call` 963-985)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (remove the last three inline closures; finalize `runWorkflow` body; remove any now-unused imports)
- Test: full suite (all 53 files)

**Interfaces:**
- Consumes: the `Runtime`/`RuntimeDeps` from Task 5; `buildCallGlobal` from `./call-global.js`; `WorkflowError`/`WorkflowErrorCode` from subagent; the inline closures to relocate — `workflowFn` (workflow.ts:695-720, calls the injected `deps.runWorkflow`), `checkpoint` (918-961, uses `hashCheckpoint` + leaf `throwIfAborted`), `call` (963-985, the `buildCallGlobal({...})` invocation whose deps are drawn from `deps.options`/`deps.state`/`deps.shared`/`deps.maxAgents`/`deps.runId` + the leaf `throwIfAborted` + the local `confirm` alias).
- Produces: extended `export interface Runtime { …; workflowFn: (nameOrScript: string, childArgs?: unknown) => Promise<unknown>; checkpoint: (promptText: string, checkpointOptions?: CheckpointOptions) => Promise<unknown>; call: ReturnType<typeof buildCallGlobal>; }` and `createRuntime` now returns all ten closures. `runWorkflow` becomes orchestration-only: setup consts → `createRuntime({...})` → `createStdlib({agent: rt.agent, parallel: rt.parallel})` → vm context (`rt.*` + `stdlib.*`) → `wrapped` → execute/persist/return.

- [ ] **Step 1: Baseline — confirm green before the final move.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: all 53 test files pass (Task 5 state).

- [ ] **Step 2: Extend `workflow-runtime.ts` — add `workflowFn`, `checkpoint`, `call` to the `Runtime` interface and `createRuntime` body.**
In `src/workflow-runtime.ts`:
- Extend the `Runtime` interface (add three members):
```ts
export interface Runtime {
  log: (message: string) => void;
  phase: (title: string, phaseOptions?: { budget?: number }) => void;
  budget: Readonly<{ total: number | null; spent: () => number; remaining: () => number }>;
  throwIfAborted: () => void;
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  workflowFn: (nameOrScript: string, childArgs?: unknown) => Promise<unknown>;
  checkpoint: (promptText: string, checkpointOptions?: CheckpointOptions) => Promise<unknown>;
  call: ReturnType<typeof buildCallGlobal>;
}
```
- Inside `createRuntime`, after `pipeline` and before `return`, add the three relocated closures (each closes over `deps.*` / locals — names already match, so bodies relocate byte-for-byte):
```ts
  // workflowFn relocated UNCHANGED from workflow.ts:695-720; the recursive runWorkflow
  // call now uses deps.runWorkflow (injected) instead of the module binding.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    // … body from workflow.ts:696-719, with `runWorkflow(childScript, {...})` → `deps.runWorkflow(childScript, {...})` …
  };

  // checkpoint relocated UNCHANGED from workflow.ts:918-961; uses hashCheckpoint + throwIfAborted (locals).
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    // … body from workflow.ts:919-960 …
  };

  // call relocated UNCHANGED from workflow.ts:962-985 (the buildCallGlobal({...}) invocation);
  // confirm is the local alias of deps.options.confirm, throwIfAborted is the local above.
  const confirm = options.confirm;
  const call = buildCallGlobal({
    hostFns: options.hostFns,
    state,
    shared,
    maxAgents,
    options: {
      resumeJournal: options.resumeJournal,
      onAgentJournal: options.onAgentJournal,
      onAgentStart: options.onAgentStart as Parameters<typeof buildCallGlobal>[0]["options"]["onAgentStart"],
      onAgentEnd: options.onAgentEnd as Parameters<typeof buildCallGlobal>[0]["options"]["onAgentEnd"],
      cwd: options.cwd ?? process.cwd(),
      signal: options.signal,
      ask: confirm ? (promptText: string, o?: HostFnAskOptions) => confirm(promptText, { ...o }) : undefined,
    },
    runId,
    throwIfAborted,
  });

  return { log, phase, budget, throwIfAborted, agent, parallel, pipeline, workflowFn, checkpoint, call };
```
The single textual edit inside `workflowFn`: change `await runWorkflow(childScript, {...})` to `await deps.runWorkflow(childScript, {...})` (the rest of the object spread — `...options, args, sharedRuntime, resumeJournal, resumeFromRunId, runId, persistLogs` — is unchanged). `checkpoint` and `call` need no edits (their captured names — `options`, `shared`, `state`, `maxAgents`, `runId`, `throwIfAborted`, `confirm`, `hashCheckpoint`, `buildCallGlobal`, `HostFnAskOptions`, `WorkflowError`, `WorkflowErrorCode` — all resolve to deps fields / locals / module imports with identical names).

- [ ] **Step 3: Remove the last three closures from `workflow.ts`; finalize `runWorkflow` orchestration-only.**
In `src/workflow.ts`:
- Remove `workflowFn` (695-720), `checkpoint` (918-961), `const confirm = options.confirm;` (962), `const call = buildCallGlobal({...});` (963-985).
- Update the vm context to route the last three closures through `rt.*`:
```ts
    agent: rt.agent,
    parallel: rt.parallel,
    pipeline: rt.pipeline,
    workflow: rt.workflowFn,
    verify: stdlib.verify,
    judgePanel: stdlib.judgePanel,
    loopUntilDry: stdlib.loopUntilDry,
    completenessCheck: stdlib.completenessCheck,
    retry: stdlib.retry,
    gate: stdlib.gate,
    checkpoint: rt.checkpoint,
    call: rt.call,
    log: rt.log,
    phase: rt.phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget: rt.budget,
    console: {
      log: rt.log,
      info: rt.log,
      warn: (m: unknown) => rt.log(`[warn] ${String(m)}`),
      error: (m: unknown) => rt.log(`[error] ${String(m)}`),
    },
```
- Remove any imports now unused in `workflow.ts` — grep first: `buildCallGlobal` (was used only by `call`, now in runtime), `HostFnAskOptions` (was used only by `call`). Confirm with `grep -n "buildCallGlobal\|HostFnAskOptions" src/workflow.ts` and delete the now-unused imports. KEEP `vm` (used by `vm.createContext`/`new vm.Script`), `createWorkflowLogger`/`parseModelRoutingFromMeta`/`resolveModelForPhase`/`loadAgentRegistry`/`providerFromModelSpec`/`getGlobalRateLimiter` (used in setup), `WorkflowError`/`WorkflowErrorCode`/`wrapError` (still used in setup `rateLimitGate`/dispatch and the dispatch error path if any — grep to confirm), `createLimiter`/`runAgentWithTimeout` (re-exported + `createLimiter` used in setup at line 331), `parseWorkflowScript`, `createRuntime`, `createStdlib`.
- The final `runWorkflow` body is orchestration-only: setup consts (291-349) → `const rt = createRuntime({...})` → `const stdlib = createStdlib({ agent: rt.agent, parallel: rt.parallel })` → `vm.createContext({...})` (all `rt.*`/`stdlib.*`) → `wrapped` (1021-1023) → execute/persist/return (1024-1044). No inline function closures remain.

- [ ] **Step 4: Verify the line target.**
Run: `( cd bun-apps/pi-agent-ext-workflow && wc -l src/workflow.ts )`
Expected: ≤ 700 lines (target ~600). `workflow.ts` now holds only: type/interface definitions (~250 lines), `DETERMINISM_PRELUDE`, `runWorkflow` orchestration (~120 lines), `normalizeConcurrency`, and the re-export statements. If > 700, an inline closure was missed — re-grep `src/workflow.ts` for `const \w+ = async` / `const \w+ = (` and move any remaining closure into the appropriate factory.

- [ ] **Step 5: Run Biome + build + full test gate.**
Run: `( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun test )`
Expected: Biome clean; `bunx tsc` clean; all 53 test files pass. No behavior change (the suite is the contract).

- [ ] **Step 6: Commit**
```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-runtime.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts
git commit -m "refactor(workflow): extend createRuntime with workflowFn/checkpoint/call; runWorkflow orchestration-only"
```
