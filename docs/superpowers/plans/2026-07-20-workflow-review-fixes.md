# pi-agent-ext-workflow Codebase-Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Resolve the four codebase-review findings (F1–F4) in `bun-apps/pi-agent-ext-workflow` so `bun run check` is green and agent start↔end snapshot correlation no longer depends on label uniqueness.

**Architecture:** F1 is a mechanical biome format pass (isolated commit). F2 threads the already-computed deterministic `callIndex` through the agent lifecycle events so `WorkflowManager` correlates entries by identity instead of `label`. F3/F4 are trivial cleanups folded into one commit.

**Tech Stack:** TypeScript + Bun + Biome 2.4.16 + typebox. Package tested via `bun run check && bun run build && bun run test:unit` (run from `bun-apps/pi-agent-ext-workflow/`).

## Global Constraints

- All shell commands run from the package dir `bun-apps/pi-agent-ext-workflow/` unless noted; never top-level `cd` (repo `no-cd-drift.sh` blocks it) — use `( cd bun-apps/pi-agent-ext-workflow && ... )`.
- Python venv / MLX stack is irrelevant here; this is a pure TS package.
- Conversation language zh-TW; all written artifacts (commits, code, comments) in English.
- Only runtime dep is `acorn`; do not add dependencies.
- Each commit must independently pass `bun run check && bun run build && bun run test:unit`.

**Spec:** `docs/superpowers/specs/2026-07-20-workflow-review-fixes-design.md`

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| (whole tree) | F1 | biome format + import sort (mechanical) |
| `src/workflow.ts` | F2 | add `callIndex` to `onAgentStart/onAgentEnd/onAgentHistory` event types + pass it at all 6 fire sites |
| `src/call-global.ts` | F2 | add `callIndex` to `AgentStartEventLike/AgentEndEventLike` + pass at 4 fire sites |
| `src/workflow-manager.ts` | F2 | store `callIndex` on snapshot entry; match by `callIndex` at the 2 correlation sites |
| `src/display.ts` | F2 | add `callIndex?: number` to `WorkflowAgentSnapshot` |
| `tests/workflow-manager.test.ts` | F2 | add duplicate-label regression test |
| `src/workflow-tool.ts` | F3, F4 | delete `_isAbortError`; guard the redundant settings disk read |

---

## Task 0: Create the feature branch

**Files:** none (git only)

- [x] **Step 1: Create and switch to the branch**

```bash
cd /Users/huangziyu/proj/video_generation__workflow
git checkout -b fix/pi-workflow-review-f1-f4
```

Expected: `Switched to a new branch 'fix/pi-workflow-review-f1-f4'`.

---

## Task 1: F1 — Restore the biome gate (mechanical)

**Files:** whole `bun-apps/pi-agent-ext-workflow` tree (format + import sort only, no logic).

- [x] **Step 1: Run the auto-fix**

```bash
( cd bun-apps/pi-agent-ext-workflow && bunx biome check --write . )
```

Expected: many files reformatted / imports reorganized; exit 0.

- [x] **Step 2: Verify the gate is green**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun run check )
```

Expected: exit 0, `Found 0 errors`. (Before this task it was 35 errors.)

- [x] **Step 3: Verify build + tests still pass (formatting must not change behavior)**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun run test:unit )
```

Expected: tsc exit 0; tests `1137 pass / 0 fail / 3 todo`.

- [x] **Step 4: Commit (F1 isolated — large mechanical diff must not mingle with logic)**

```bash
cd /Users/huangziyu/proj/video_generation__workflow
git add bun-apps/pi-agent-ext-workflow
git commit -m "style(pi-agent-ext-workflow): biome format + import sort

Auto-fix 35 biome formatter/import-organization diagnostics so
\`bun run check\` (and the CI \`npm test\` gate) pass again. Pure
formatting + import reordering, zero logic change."
```

---

## Task 2: F2 — Correlate workflow agents by `callIndex`

`callIndex = state.callSeq++` is already computed in `agent()` (`workflow.ts`) and in `call()` (`call-global.ts`). It is unique per lexical call and stable across resume. We expose it on the lifecycle events and match by it in the manager.

### Task 2a: Write the failing regression test (TDD)

**Files:**
- Modify: `tests/workflow-manager.test.ts` (append a test + a helper)

**Interfaces:**
- Consumes: `WorkflowManager.runSync(script, args, exec)` with a stub `agent` runner; `WorkflowManager.getRun(runId)` → `ManagedRun.snapshot.agents` (`WorkflowAgentSnapshot[]`, each has `label`, `prompt`, `resultPreview`).

- [x] **Step 1: Add the helper + test at the end of `tests/workflow-manager.test.ts`**

Append exactly:

```ts
/**
 * Stub agent whose Nth call waits delay[N] then returns its prompt verbatim.
 * Delays are chosen so finish order != start order (middle call finishes first),
 * which is what exposes label-based start↔end mis-correlation.
 */
function reversedFinishAgent() {
  let n = 0;
  const delays = [30, 10, 20]; // start order AAA,BBB,CCC -> finish BBB,CCC,AAA
  return {
    async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      const delay = delays[n++] ?? 10;
      await new Promise((resolve) => setTimeout(resolve, delay));
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return prompt;
    },
  };
}

test(
  "F2: parallel agents sharing a label correlate start↔end by callIndex, not label",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: reversedFinishAgent() });
    const script = `export const meta = { name: 'dup_label', description: 'shared label parallel' }
const prompts = ['AAA', 'BBB', 'CCC']
const out = await parallel(prompts.map((p) => () => agent(p, { label: 'shared' })))
return out`;
    await manager.runSync(script, undefined, { concurrency: 3 });

    const runs = manager.listRuns();
    const agents = manager.getRun(runs[0]!.runId)!.snapshot.agents;

    // Sanity: three agents ran, all under the shared label.
    assert.equal(agents.length, 3);
    assert.ok(agents.every((a) => a.label === "shared"));

    // The regression: with label-based matching, finisher BBB's result was
    // attached to entry "CCC" (last-pushed running), etc. Each agent's stored
    // resultPreview MUST equal its own prompt — identity pairing.
    for (const a of agents) {
      assert.equal(
        a.resultPreview,
        a.prompt,
        `agent prompt "${a.prompt}" got result "${a.resultPreview}" (label-based mis-correlation)`,
      );
    }
  }),
);
```

- [x] **Step 2: Run the new test to verify it FAILS on the current (pre-fix) code**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager.test.ts -t "F2: parallel agents" )
```

Expected: **FAIL** — at least one assertion `agent prompt "BBB" got result "CCC" ...` (the label-based mis-correlation). This proves the test guards the regression.

### Task 2b: Thread `callIndex` through the events

**Files:**
- Modify: `src/display.ts` (snapshot type)
- Modify: `src/workflow.ts` (event types + 6 fire sites)
- Modify: `src/call-global.ts` (event types + 4 fire sites)
- Modify: `src/workflow-manager.ts` (store + 2 match sites)

**Interfaces:**
- Produces: every `onAgentStart`/`onAgentEnd`/`onAgentHistory` event now carries `callIndex: number`; `WorkflowAgentSnapshot.callIndex?: number`.

> **Execution note (oldText freshness):** the `Old:` snippets below were captured from the *pre-format* source. Task 1's biome pass may re-wrap some one-liners / object literals. Before applying each edit, re-read the actual region (`grep -n` the distinctive token) and adjust `oldText` to the post-format text. The *New:* side is what matters; only `callIndex,` / `callIndex: ...` is being added.

- [x] **Step 1: Add `callIndex` to the snapshot type (`src/display.ts`)**

In `WorkflowAgentSnapshot` (the block starting `export interface WorkflowAgentSnapshot {`), add `callIndex` right after `id`:

Old:
```ts
export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
```
New:
```ts
export interface WorkflowAgentSnapshot {
  id: number;
  /** Deterministic call index (the journal key) — stable identity for start↔end correlation. */
  callIndex?: number;
  label: string;
```

- [x] **Step 2: Add `callIndex` to the three event types (`src/workflow.ts`)**

Old (the `onAgentStart` line):
```ts
  onAgentStart?: (event: { label: string; phase?: string; prompt: string; model?: string }) => void;
```
New:
```ts
  onAgentStart?: (event: { callIndex: number; label: string; phase?: string; prompt: string; model?: string }) => void;
```

Old (the `onAgentEnd` event, first property line):
```ts
  onAgentEnd?: (event: {
    label: string;
```
New:
```ts
  onAgentEnd?: (event: {
    callIndex: number;
    label: string;
```

Old (the `onAgentHistory` line):
```ts
  onAgentHistory?: (event: { label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
```
New:
```ts
  onAgentHistory?: (event: { callIndex: number; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
```

- [x] **Step 3: Pass `callIndex` at all 6 fire sites in `agent()` (`src/workflow.ts`)**

`callIndex` is already in scope at every site (`const callIndex = state.callSeq++`).

Cached-replay start (one-liner):
Old: `      options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });`
New: `      options.onAgentStart?.({ callIndex, label, phase: assignedPhase, prompt, model: displayModel });`

Cached-replay end (one-liner):
Old: `      options.onAgentEnd?.({ label, phase: assignedPhase, result: cached.result, tokens: 0, model: displayModel });`
New: `      options.onAgentEnd?.({ callIndex, label, phase: assignedPhase, result: cached.result, tokens: 0, model: displayModel });`

Live start (one-liner, inside the limiter):
Old: `      options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });`
New: `      options.onAgentStart?.({ callIndex, label, phase: assignedPhase, prompt, model: displayModel });`

> NOTE: the cached-start and live-start one-liners are textually identical. To keep `edit` targets unique, do these two as a single `edit` call is impossible (duplicate oldText). Instead, after running biome in Task 1 the file is reformatted; locate each by its surrounding context (the cached pair sits right after `if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {`; the live one sits right after `options.onAgentStart?.(...)` inside `return limiter(async () => {`. Apply each replacement using enough adjacent context (e.g. include the preceding `if` line for the cached pair) so the oldText is unique.

Live success-end object (add `callIndex,` as the first property):
Old:
```ts
            options.onAgentEnd?.({
              label,
              phase: assignedPhase,
              result,
```
New:
```ts
            options.onAgentEnd?.({
              callIndex,
              label,
              phase: assignedPhase,
              result,
```

Live error-end object (add `callIndex,` as the first property):
Old:
```ts
            options.onAgentEnd?.({
              label,
              phase: assignedPhase,
              result: null,
```
New:
```ts
            options.onAgentEnd?.({
              callIndex,
              label,
              phase: assignedPhase,
              result: null,
```

- [x] **Step 4: Add `callIndex` to `call-global.ts` event types**

Old:
```ts
export interface AgentStartEventLike {
  label: string;
  phase: string;
  prompt: string;
  model: string;
}
```
New:
```ts
export interface AgentStartEventLike {
  callIndex: number;
  label: string;
  phase: string;
  prompt: string;
  model: string;
}
```

Old:
```ts
export interface AgentEndEventLike {
  label: string;
  phase: string;
  result: unknown;
  tokens: number;
  model: string;
}
```
New:
```ts
export interface AgentEndEventLike {
  callIndex: number;
  label: string;
  phase: string;
  result: unknown;
  tokens: number;
  model: string;
}
```

- [x] **Step 5: Pass `callIndex` at all 4 fire sites in `call-global.ts`**

`callIndex` is already in scope in `buildCallGlobal`'s returned closure (`const callIndex = deps.state.callSeq++`).

Cached-replay start:
Old: `      deps.options.onAgentStart?.({ label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });`
New: `      deps.options.onAgentStart?.({ callIndex, label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });`

Cached-replay end (add `callIndex,` as first property):
Old:
```ts
      deps.options.onAgentEnd?.({
        label: namespaced,
        phase: phase(),
        result: cached.result,
```
New:
```ts
      deps.options.onAgentEnd?.({
        callIndex,
        label: namespaced,
        phase: phase(),
        result: cached.result,
```

Live start:
Old: `    deps.options.onAgentStart?.({ label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });`
New: `    deps.options.onAgentStart?.({ callIndex, label: namespaced, phase: phase(), prompt: "", model: HOST_FN_MODEL });`

> NOTE: the two `onAgentStart` one-liners differ only by leading whitespace (4 vs 6 spaces) — that makes them unique. Verify with the exact indentation shown.

Live end:
Old: `    deps.options.onAgentEnd?.({ label: namespaced, phase: phase(), result, tokens: 0, model: HOST_FN_MODEL });`
New: `    deps.options.onAgentEnd?.({ callIndex, label: namespaced, phase: phase(), result, tokens: 0, model: HOST_FN_MODEL });`

- [x] **Step 6: Store `callIndex` and match by it in `workflow-manager.ts`**

In the `onAgentStart` handler, add `callIndex` to the pushed object:
Old:
```ts
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
```
New:
```ts
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            callIndex: event.callIndex,
            label: event.label,
```

In the `onAgentEnd` handler, change the correlation predicate (two identical occurrences — one in `onAgentEnd`, one in `onAgentHistory`; update BOTH):
Old:
```ts
            .find((a) => a.label === event.label && a.status === "running");
```
New:
```ts
            .find((a) => a.callIndex === event.callIndex && a.status === "running");
```

> NOTE: this oldText appears twice (lines ~460 and ~476). Apply the replacement to both. If the edit tool rejects a duplicate oldText in one call, do two calls each scoped with adjacent unique context (e.g. include the preceding `const agent = [...managed.snapshot.agents]` line plus the following differing line — `onAgentEnd` is followed by `if (agent) { agent.status = ...` while `onAgentHistory` is followed by `if (agent) { agent.history = ...`).

- [x] **Step 7: Run the F2 regression test — verify it now PASSES**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-manager.test.ts -t "F2: parallel agents" )
```

Expected: **PASS**.

- [x] **Step 8: Run the FULL suite + build + gate (event-shape change is additive; nothing else should break)**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun run test:unit )
```

Expected: `check` exit 0; `build` exit 0; tests all pass (`1138 pass / 0 fail / 3 todo` — one more pass than before, the new F2 test).

- [x] **Step 9: Commit F2**

```bash
cd /Users/huangziyu/proj/video_generation__workflow
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/src/workflow.ts bun-apps/pi-agent-ext-workflow/src/call-global.ts bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts bun-apps/pi-agent-ext-workflow/tests/workflow-manager.test.ts
git commit -m "refactor(pi-agent-ext-workflow): correlate workflow agents by callIndex

WorkflowManager previously matched onAgentEnd/onAgentHistory to the
start entry by label, so parallel agents sharing a label could have
results attached to the wrong entry. Thread the already-computed
deterministic callIndex (the journal key) through all agent lifecycle
events and match by it instead. Additive on the (internal) event shape;
adds a duplicate-label regression test."
```

---

## Task 3: F3 + F4 — Dead code + redundant settings read

**Files:**
- Modify: `src/workflow-tool.ts`

- [x] **Step 1: F4 — guard the redundant settings disk read**

In `createWorkflowTool`, replace the always-eager defaults + manager construction:

Old:
```ts
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
      extensionTools: options.extensionTools,
    });
```
New:
```ts
  // Read settings from disk ONLY when constructing the fallback manager. When
  // the extension supplies options.manager (the normal path), skip the read.
  // The `?? null` / `?? 0` mirror WorkflowManager's own constructor defaults so
  // behavior is identical when fallbackDefaults is present.
  const fallbackDefaults = options.manager ? undefined : resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: fallbackDefaults?.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: fallbackDefaults?.agentTimeoutMs ?? null,
      defaultAgentRetries: fallbackDefaults?.agentRetries ?? 0,
      extensionTools: options.extensionTools,
    });
```

- [x] **Step 2: F3 — delete the dead `_isAbortError`**

Delete this entire function (it is defined but never called; `errors.ts` exports the canonical `isAbortError`):

```ts
function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
```

- [x] **Step 3: Verify gate + build + full suite**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun run test:unit )
```

Expected: `check` exit 0; `build` exit 0; all tests pass (no behavior change — the tool-construction path is covered by existing tests, e.g. `tests/workflow-tool*.test.ts`).

- [x] **Step 4: Commit F3 + F4**

```bash
cd /Users/huangziyu/proj/video_generation__workflow
git add bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts
git commit -m "chore(pi-agent-ext-workflow): drop dead code, skip redundant settings read

- Remove unused _isAbortError (errors.ts exports the canonical isAbortError).
- In createWorkflowTool, only read workflow settings from disk when
  constructing the fallback manager (options.manager absent); the normal
  extension path already passes a manager, so the read was wasted."
```

---

## Task 4: Final verification (definition of done)

- [x] **Step 1: Full gate from a clean build**

```bash
( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun run test:unit )
```

Expected: `check` exit 0 (was 35 errors); `build` exit 0; tests all pass with the new F2 test present; the 3 unrelated todo tests stay todo.

- [x] **Step 2: Confirm commit history is clean and F2/F3/F4 carry no formatting noise**

```bash
cd /Users/huangziyu/proj/video_generation__workflow
git log --oneline -4
git diff HEAD~3..HEAD~2 --stat            # F2: only the 4 src files + 1 test
git diff HEAD~1..HEAD --stat              # F3+F4: only workflow-tool.ts
```

Expected: 3 commits on top of the branch point; F2/F3/F4 diffs are logic-only (all formatting absorbed in the F1 commit).

- [x] **Step 3: Report results** — summarize the four green gates and the commit list to the user; do not merge (leave that to the user / a finishing-a-development-branch decision).
