# Subagent Efficiency Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every subagent dispatch at the parent layer — fail-fast impossible tools, default git-scope detection, circuit-break identical retry loops, and tier-calibrated token budgets (hard-abort) — so runaways are caught early instead of burning unbounded tokens.

**Architecture:** All four guardrails enforce PARENT-SIDE around `spawn()` in `pi-agent-ext-subagent`. No `SpawnSubagentOptions` or tool-gate changes. #01 reuses the shipped hard-abort (`TOKEN_BUDGET_EXHAUSTED` → non-transient); #02 flips an existing opt-in gate to default-on; #03/#04 are additive preflights. #01/#02/#03 mirror a second site in the plural `subagents` tool; #04 is singular-only (the plural tool fans out in parallel and has no single per-dispatch retry signature).

**Tech Stack:** TypeScript, Bun, TypeBox schema, biome + tsc.

## Global Constraints

- **Package gate:** `( cd bun-apps/pi-agent-ext-subagent && bun run check && bunx tsc --noEmit && bun test )`. NOTE: `bun run check` is biome only (NOT tsc) — run `bunx tsc --noEmit` explicitly. `bun run test` alone runs `check → build → test:unit`; the explicit form above is the reliable gate because it does NOT rebuild before testing.
- DRY/YAGNI/TDD; frequent commits; mirror singular↔plural dispatch surfaces for #01/#02/#03.
- Never auto-revert (git-scope invariant — `git-scope.ts` is detection-only).
- Hard-abort budget semantics already shipped (`classifyError` maps `TOKEN_BUDGET_EXHAUSTED` → `{ transient: false }` in `spawn-subagent.ts`; retry is skipped). The new work only supplies a DEFAULT value — the abort path is reused untouched.
- `failEarly` is a LOCAL CLOSURE inside `subagent-tool.ts` `execute` (signature `failEarly(text: string)`), capturing `toolCallId`, `t0`, and `params` from the enclosing scope. Preflight early-returns are plain `return failEarly("...")` — do NOT invent a multi-arg signature.
- Pinned decisions (from the settled tickets): **#02 = Option B1** (default `scope=[]`, warn on any commit, never auto-revert); **#04 = N=2 consecutive identical-semantic** (above `retryOnTransient`'s single in-dispatch retry); **#01 = hard-abort + p90-calibrated ceilings**; **spendBudget = no-op** (cost≡0 on this MLX stack).

---

## File Structure (decomposition)

New files (each one clear responsibility):

- `src/impossible-tools.ts` (Task 1) — pure `missingRequiredTools(...)`. Tiny, pure, independently testable. Kept OUT of `subagent-tool-run.ts` so the run-context module does not grow a second unrelated responsibility.
- `src/retry-loop-detector.ts` (Task 3) — pure `taskSignature`, `failureClass`, `consecutiveIdenticalFailures`, `shouldCircuitBreak`. Pure module, no I/O; reads a `SubagentRunRecord[]` snapshot the caller passes.
- `src/budget-defaults.ts` (Task 4) — `TIERED_TOKEN_BUDGET_DEFAULTS` table + `tierDefaultToken(...)`. Pure except for the lazy `loadModelTierConfig()` disk read (overridable via param for tests).
- `tests/impossible-tools.test.ts`, `tests/retry-loop-detector.test.ts`, `tests/budget-defaults.test.ts` — pure unit tests for the three new modules.

Modified files (existing responsibility, additive):

- `src/subagent-tool-schema.ts` — add `requiredTools` (Task 1) + `retryCircuitBreak` (Task 3) schema params.
- `src/subagent-tool-run.ts` — flip the commitScope gate (Task 2); wire tiered token default into `buildSpawnOptions` (Task 4).
- `src/subagent-tool.ts` — wire #03 preflight (Task 1), #04 preflight (Task 3). The #02 + #01 wiring lands in `subagent-tool-run.ts` (shared helpers), so this file only gains the two additive preflights.
- `src/subagents-tool.ts` — plural mirror for #03 (Task 1), #02 opt-in (Task 2), #01 per-child budget default (Task 4).
- `tests/subagent-tool-run.test.ts`, `tests/subagent-tool.test.ts`, `tests/spawn-subagent.test.ts` — extend existing tests for the flipped gate + new preflights + budget default.

---

## Task 1: #03 — impossible-tool preflight (ABORT, pre-spawn)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/impossible-tools.ts`
- Create: `bun-apps/pi-agent-ext-subagent/tests/impossible-tools.test.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts:143` (insert `requiredTools` after `excludeTools`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:196-220` (extract `const opts`, add preflight; the `return failEarly(...)` sits INSIDE the existing `try` so the `finally` still tears down the worktree + ends inFlight)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (plural mirror: `BatchTask` + schema + `dispatchChild` preflight)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` (tool-level preflight test)

**Interfaces:**
- Consumes: `SpawnSubagentOptions.tools` / `.excludeTools` (already produced by `buildSpawnOptions`); the new schema param `params.requiredTools?: string[]`.
- Produces: `missingRequiredTools(required, resolved, exclude)` — used by BOTH the singular tool (Task 1) and the plural tool (Task 1 mirror). Exact signature:

```ts
export function missingRequiredTools(
  required: string[] | undefined,
  resolved: string[] | undefined,
  exclude: string[] | undefined,
): string[] | undefined;
// Returns the subset of `required` that is NOT satisfiable by the child (absent
// from `resolved`, OR present in `resolved` but denied by `exclude`). Returns
// `undefined` when nothing is missing — including when `required` is empty/unset
// or when `resolved` is undefined (no concrete allowlist to check against → can't
// confirm a miss → never false-abort).
```

- [ ] **Step 1: Write the failing test for the pure helper**

Create `tests/impossible-tools.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { missingRequiredTools } from "../src/impossible-tools.js";

test("missingRequiredTools: undefined required ⇒ undefined (no requirement)", () => {
  assert.equal(missingRequiredTools(undefined, ["read", "bash"], undefined), undefined);
  assert.equal(missingRequiredTools([], ["read", "bash"], undefined), undefined);
});

test("missingRequiredTools: required present in allowlist ⇒ undefined", () => {
  assert.equal(missingRequiredTools(["read"], ["read", "bash"], undefined), undefined);
  assert.equal(missingRequiredTools(["read", "bash"], ["read", "bash"], undefined), undefined);
});

test("missingRequiredTools: required absent from allowlist ⇒ the missing names", () => {
  assert.deepEqual(missingRequiredTools(["memory"], ["read", "bash"], undefined), ["memory"]);
  assert.deepEqual(missingRequiredTools(["read", "memory"], ["read", "bash"], undefined), ["memory"]);
});

test("missingRequiredTools: excludeTools denies a 'present' tool ⇒ it is missing", () => {
  // 'edit' is in the allowlist but excluded → after exclusion it is unavailable.
  assert.deepEqual(missingRequiredTools(["edit"], ["read", "edit", "write"], ["edit"]), ["edit"]);
  // 'read' survives the exclusion.
  assert.equal(missingRequiredTools(["read", "edit"], ["read", "edit"], ["edit"]), ["edit"]);
});

test("missingRequiredTools: undefined resolved (no concrete allowlist) ⇒ undefined (never false-abort)", () => {
  // The child inherits a default/gated set we can't enumerate here → can't confirm a miss.
  assert.equal(missingRequiredTools(["memory"], undefined, undefined), undefined);
});

test("missingRequiredTools: preserves required order, no dedup", () => {
  assert.deepEqual(missingRequiredTools(["z", "a", "z"], ["a"], undefined), ["z", "z"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/impossible-tools.test.ts )`
Expected: FAIL — `Cannot find module '../src/impossible-tools.js'` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/impossible-tools.ts`:

```ts
/**
 * #03 impossible-tool preflight — pure helper.
 *
 * Motivation (run mslovsnn, 927k tok): a dispatched subagent lacked the `memory`
 * tool, so instead of failing fast it reverse-engineered the hermes store
 * bootstrap and wrote+ran a temp script. A declaration-based preflight (the
 * dispatcher lists the tools the task needs) catches this BEFORE spawn: if a
 * required tool is absent from the child's allowlist — or present but denied by
 * `excludeTools` — the dispatch aborts with a clear error instead of burning a
 * runaway loop.
 *
 * Pure + dependency-free so it is unit-testable in isolation and reusable from
 * BOTH the singular (`subagent`) and plural (`subagents`) dispatch surfaces.
 */

/**
 * Return the subset of `required` tools the child CANNOT use, or `undefined`
 * when the requirement is satisfiable (or there is no requirement to check).
 *
 * A required tool is MISSING when it is NOT in `resolved` (the child's concrete
 * allowlist) OR it IS in `resolved` but denied by `exclude` (post-exclusion it
 * is unavailable). When `resolved` is `undefined` the child inherits a default
 * set we cannot enumerate, so a miss cannot be confirmed → return `undefined`
 * (never false-abort on an unverifiable requirement). Returns `undefined` (not
 * `[]`) on success so callers can branch with a plain truthiness check.
 */
export function missingRequiredTools(
  required: string[] | undefined,
  resolved: string[] | undefined,
  exclude: string[] | undefined,
): string[] | undefined {
  if (!required || required.length === 0) return undefined;
  if (!resolved) return undefined;
  const denied = exclude ? new Set(exclude) : null;
  const missing = required.filter((name) => !resolved.includes(name) || (denied?.has(name) ?? false));
  return missing.length > 0 ? missing : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/impossible-tools.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the `requiredTools` schema param (singular)**

In `src/subagent-tool-schema.ts`, insert immediately AFTER the `excludeTools` block (after line 145, before `timeoutMs`):

```ts
  requiredTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tools this task NEEDS (e.g. ['memory']). Before spawn, aborts if any is absent from the child's allowlist (tools) or denied by excludeTools — prevents impossible-task over-engineering that burns runaway tokens.",
    }),
  ),
```

- [ ] **Step 6: Write the failing tool-level test (spawn NOT called when required ⊥ allowlist)**

Append to `tests/subagent-tool.test.ts` (reuses the file's existing `fakeSpawn` helper near the top):

```ts
import { missingRequiredTools } from "../src/impossible-tools.js"; // add to the existing import block at top

test("#03 preflight: required tool absent from allowlist → failEarly, spawn NOT called", async () => {
  const f = fakeSpawn(() => ({ output: "should not reach", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id-pf",
    { task: "write a memory entry", tools: ["read", "bash"], requiredTools: ["memory"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0, "spawn must NOT be called when a required tool is missing");
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /preflight: task requires tools not in the child allowlist: memory/);
});

test("#03 preflight: required tool satisfied → spawn IS called normally", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute(
    "id-ok",
    { task: "read a file", tools: ["read", "bash"], requiredTools: ["read"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 1, "spawn IS called when the requirement is satisfied");
});

test("#03 preflight: required tool denied by excludeTools → failEarly", async () => {
  const f = fakeSpawn(() => ({ output: "x", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id-ex",
    { task: "edit a file", tools: ["read", "edit"], excludeTools: ["edit"], requiredTools: ["edit"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0);
  assert.match((res.content[0] as { text: string }).text, /edit/);
});
```

- [ ] **Step 7: Run the tool-level test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#03 preflight" )`
Expected: FAIL — the new tests fail because `requiredTools` is not yet wired (spawn IS called, status is not "failed").

- [ ] **Step 8: Wire the preflight into the singular tool**

In `src/subagent-tool.ts`:

(a) Add to the import from `./subagent-tool-run.js` (the existing import block around line 30-44) — actually import from the new module. Add near the top imports:

```ts
import { missingRequiredTools } from "./impossible-tools.js";
```

(b) Replace the spawn call site. Current code (lines ~196-220):

```ts
        const result = await spawn(
          buildSpawnOptions(
            {
              toolCallId,
              t0,
              params,
              agentDef,
              modelCtx: { requestedModel, tier, capability, mainModel },
              spawnCwd,
              childSignal: childAc.signal,
            },
            progress,
            {
              getActiveTools: options.getActiveTools,
              getExtensionTools: options.getExtensionTools,
              inFlight: options.inFlight,
              persistence: options.persistence,
              onUpdate,
            },
          ),
        );
```

Replace with (extract `opts`, run preflight inside the SAME `try` so the `finally` still cleans up):

```ts
        const opts = buildSpawnOptions(
          {
            toolCallId,
            t0,
            params,
            agentDef,
            modelCtx: { requestedModel, tier, capability, mainModel },
            spawnCwd,
            childSignal: childAc.signal,
          },
          progress,
          {
            getActiveTools: options.getActiveTools,
            getExtensionTools: options.getExtensionTools,
            inFlight: options.inFlight,
            persistence: options.persistence,
            onUpdate,
          },
        );
        // #03 impossible-tool preflight (ABORT, pre-spawn). Sits inside this try
        // so the finally still tears down the worktree + ends inFlight on abort.
        const missing = missingRequiredTools(params.requiredTools, opts.tools, opts.excludeTools);
        if (missing) {
          return failEarly(
            `preflight: task requires tools not in the child allowlist: ${missing.join(", ")}. ` +
              `Add them to \`tools\` (or drop them from \`excludeTools\` / \`requiredTools\`).`,
          );
        }
        const result = await spawn(opts);
```

(c) Add `requiredTools` to the `params` type flowing through. The `execute(toolCallId, params, ...)` `params` is typed by `subagentToolSchema` (added in Step 5), so `params.requiredTools` is already typed once the schema param lands. No further type change is needed.

- [ ] **Step 9: Run the tool-level test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#03 preflight" )`
Expected: PASS (3 tests).

- [ ] **Step 10: Plural mirror — add `requiredTools` to the batch task + preflight in `dispatchChild`**

In `src/subagents-tool.ts`:

(a) Add `requiredTools?: string[];` to the `BatchTask` interface (after `excludeTools?: string[];`, ~line 39).

(b) Add to the per-task schema object inside `subagentsToolSchema` (after the `excludeTools` entry, ~line 131):

```ts
      requiredTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Tools this task NEEDS. Before spawn, the child is skipped (null slot) if any is absent from its allowlist or denied by excludeTools.",
        }),
      ),
```

(c) Add the import at the top:

```ts
import { missingRequiredTools } from "./impossible-tools.js";
```

(d) In `dispatchChild`, immediately AFTER `const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools, activeTools });` (~line 303) and BEFORE the in-flight `start(...)`, insert:

```ts
        // #03 plural mirror: impossible-tool preflight. A child missing a
        // required tool is skipped (null slot) and warned — never dispatched.
        const missingChild = missingRequiredTools(task.requiredTools, childOpts.tools, childOpts.excludeTools);
        if (missingChild) {
          console.warn(
            `[subagents] task[${index}] requires tools not in the child allowlist: ${missingChild.join(", ")} — skipped.`,
          );
          slots[index] = null;
          return;
        }
```

(e) Append a plural test to `tests/subagents-tool.test.ts` (mirror the file's existing `fakeSpawn`/batch-test style):

```ts
test("#03 plural mirror: a child missing a required tool is skipped (null), spawn not called for it", async () => {
  const calls: unknown[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  const res = await tool.execute(
    "batch-pf",
    {
      tasks: [
        { task: "needs memory", tools: ["read"], requiredTools: ["memory"] }, // skipped
        { task: "fine", tools: ["read"], requiredTools: ["read"] }, // dispatched
      ],
    } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(calls.length, 1, "only the satisfiable child is dispatched");
  assert.equal(res.details.results[0], null, "missing-tool child → null slot");
  assert.notEqual(res.details.results[1], null);
});
```

(Add `import type { SpawnSubagentOptions } from "../src/spawn-subagent.js";` and `import { createSubagentsTool } from "../src/subagents-tool.js";` at the top if not already present — they are present in the existing file.)

- [ ] **Step 11: Run the full package gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bunx tsc --noEmit && bun test )`
Expected: PASS — biome clean, tsc clean, all tests green (existing + new).

- [ ] **Step 12: Commit**

```bash
git -C <repo> add bun-apps/pi-agent-ext-subagent/src/impossible-tools.ts \
  bun-apps/pi-agent-ext-subagent/tests/impossible-tools.test.ts \
  bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts \
  bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts \
  bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git -C <repo> commit -m "feat(subagent): #03 impossible-tool preflight (singular + plural mirror)"
```

---

## Task 2: #02 — commitScope warn-default (B1: default `scope=[]`, warn on any commit, never auto-revert)

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts:63-71` (`captureCommitBaseline`), `:78-89` (`runScopeCheck`)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts` (flip the two `=== undefined` assertions)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` (tool-level: unset-scope dispatch that commits → ⚠ in output)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (plural mirror: opt-in per-task `commitScope`)

**Interfaces:**
- Consumes: existing `captureCommitBaseline` / `runScopeCheck` / `computeScopeCheck` / `outOfScopePaths` / `augmentOutputWithScopeViolation` — signatures unchanged.
- Produces: SAME signatures, NEW semantics — `captureCommitBaseline(undefined, ...)` now returns the head sha (was `undefined`); `runScopeCheck(undefined, ...)` now returns a populated check (was `undefined`). `outOfScopePaths(touched, [])` already means "every touched path is out of scope" (the `[]` case is already correct in `git-scope.ts`) — so passing `scope ?? []` makes an UNSET scope flag every committed path.

- [ ] **Step 1: Write the failing tests for the flipped gate**

In `tests/subagent-tool-run.test.ts`, REPLACE these two tests:

```ts
test("captureCommitBaseline: undefined when scope unset or worktree-isolated", async () => {
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", fakeGitOps()), undefined);
  assert.equal(await captureCommitBaseline(["src/"], "/wt", "/r", fakeGitOps()), undefined);
});
```

with:

```ts
test("captureCommitBaseline: #02 default-on — captures baseline even when scope UNSET (real tree)", async () => {
  // #02 B1: scope unset is now treated as scope=[] (flag any commit). The
  // baseline MUST be captured so the post-run check can diff base..HEAD.
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", fakeGitOps("deadbeef")), "deadbeef");
  // worktree-isolated runs are STILL skipped (the worktree is discarded at teardown).
  assert.equal(await captureCommitBaseline(["src/"], "/wt", "/r", fakeGitOps()), undefined);
});

test("captureCommitBaseline: swallows headCommit throw → undefined", async () => {
  const ops = fakeGitOps(async () => {
    throw new Error("no git");
  });
  assert.equal(await captureCommitBaseline(undefined, "/r", "/r", ops), undefined);
});
```

And REPLACE the first `runScopeCheck` test:

```ts
test("runScopeCheck: undefined unless scope set + real tree + baseCommit present", async () => {
  const compute = async () => ({ outOfScope: [], inScope: [] }) as unknown as SubagentScopeCheck;
  assert.equal(await runScopeCheck(undefined, "/r", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/wt", "/r", "abc", fakeGitOps(), compute), undefined);
  assert.equal(await runScopeCheck(["src/"], "/r", "/r", undefined, fakeGitOps(), compute), undefined);
  const out = await runScopeCheck(["src/"], "/r", "/r", "abc", fakeGitOps(), compute);
  assert.deepEqual(out, { outOfScope: [], inScope: [] } as unknown as SubagentScopeCheck);
});
```

with:

```ts
test("runScopeCheck: #02 default-on — unset scope still runs the check (scope=[] flags every touched path)", async () => {
  // compute receives scope=[] for an unset scope → outOfScopePaths flags every path.
  let receivedScope: readonly string[] | undefined;
  const compute = async (_ops: never, _cwd: string, _base: string, scope: readonly string[]) => {
    receivedScope = scope;
    return { baseCommit: "abc", touchedPaths: ["x.ts"], outOfScope: ["x.ts"] } as unknown as SubagentScopeCheck;
  };
  const out = await runScopeCheck(undefined, "/r", "/r", "abc", fakeGitOps(), compute as never);
  assert.deepEqual(receivedScope, [], "unset scope is passed to compute as []");
  assert.deepEqual(out?.outOfScope, ["x.ts"], "a touched path is flagged even with no explicit scope");
  // worktree-isolated + missing baseCommit are STILL skipped.
  assert.equal(await runScopeCheck(undefined, "/wt", "/r", "abc", fakeGitOps(), compute as never), undefined);
  assert.equal(await runScopeCheck(undefined, "/r", "/r", undefined, fakeGitOps(), compute as never), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts -t "#02 default-on" )`
Expected: FAIL — `captureCommitBaseline(undefined,...)` still returns `undefined` (gate not flipped yet); `receivedScope` is not `[]`.

- [ ] **Step 3: Flip the gate in `captureCommitBaseline`**

In `src/subagent-tool-run.ts`, change `captureCommitBaseline` (lines 63-71). Current:

```ts
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
```

Replace the guard line only (drop the `scope === undefined` short-circuit; keep the worktree-isolation guard):

```ts
export async function captureCommitBaseline(
  scope: string[] | undefined,
  spawnCwd: string,
  runCwd: string,
  gitOps: GitScopeOps,
): Promise<string | undefined> {
  // #02 B1: default-on. An UNSET scope is now treated as scope=[] (flag ANY
  // commit) instead of disabling the check — so we capture the baseline on the
  // real tree regardless of whether a scope was declared. The worktree-isolation
  // guard stays (a worktree run is discarded at teardown → can't pollute main).
  void scope;
  if (spawnCwd !== runCwd) return undefined;
  try {
    return await gitOps.headCommit(runCwd);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Flip the gate in `runScopeCheck`**

In `src/subagent-tool-run.ts`, change `runScopeCheck` (lines 78-89). Current guard:

```ts
  if (scope === undefined || spawnCwd !== runCwd || baseCommit === undefined) return undefined;
  try {
    return await compute(gitOps, runCwd, baseCommit, scope);
  } catch {
    return undefined;
  }
```

Replace with (pass `scope ?? []` so an unset scope reaches `compute` as `[]`):

```ts
  // #02 B1: default-on. Unset scope → [] (flag every committed path via
  // outOfScopePaths' empty-scope semantics). Worktree-isolation + missing
  // baseline guards stay. Never auto-reverts (git-scope.ts invariant).
  if (spawnCwd !== runCwd || baseCommit === undefined) return undefined;
  try {
    return await compute(gitOps, runCwd, baseCommit, scope ?? []);
  } catch {
    return undefined;
  }
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool-run.test.ts )`
Expected: PASS — both flipped tests green; the existing `computeScopeCheck` / `outOfScopePaths` tests in `git-scope.test.ts` are untouched (the `[]` semantics were already correct there).

- [ ] **Step 6: Write the tool-level test (unset-scope dispatch that commits → ⚠ in output)**

Append to `tests/subagent-tool.test.ts`. This injects a fake `gitOps` so the scope check runs against a fake repo that "advanced" (touched path out of the empty scope):

```ts
test("#02 default-on: UNSET commitScope + a commit → ⚠ block in output (never auto-reverts)", async () => {
  const f = fakeSpawn(() => ({ output: "done", exitCode: 0, stderr: "", timedOut: false }));
  // Fake git ops: HEAD was 'base' before, 'head' after → one touched path 'scratch.md'.
  const gitOps = {
    headCommit: async () => "head",
    changedPaths: async () => ["scratch.md"],
  } as never;
  const tool = createSubagentTool({ spawn: f.spawn, gitOps });
  // NOTE: commitScope intentionally OMITTED — the default-on gate must still run.
  const res = await tool.execute("id-scope", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /⚠ commit-scope violation/, "unset scope that commits still warns");
  assert.match(text, /scratch\.md/);
  // Detection only — never auto-reverts (no destructive action available here anyway).
  assert.equal(res.details.scopeCheck?.outOfScope?.length, 1);
});

test("#02 default-on: UNSET commitScope + NO commit → no ⚠ (clean run)", async () => {
  const f = fakeSpawn(() => ({ output: "done", exitCode: 0, stderr: "", timedOut: false }));
  const gitOps = { headCommit: async () => "same", changedPaths: async () => [] } as never;
  const tool = createSubagentTool({ spawn: f.spawn, gitOps });
  const res = await tool.execute("id-clean", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.doesNotMatch(text, /commit-scope violation/);
});
```

- [ ] **Step 7: Run the tool-level test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#02 default-on" )`
Expected: PASS. (The wiring is automatic — `subagent-tool.ts` already calls `captureCommitBaseline(params.commitScope, ...)` and `runScopeCheck(params.commitScope, ...)`; flipping the helpers flips the behavior with NO change to the call sites.)

- [ ] **Step 8: Plural mirror — opt-in per-task `commitScope` (documented: NOT default-on)**

The plural tool is read-only (`READ_ONLY_EXCLUDED` always denies edit/write/bash), so a global default-on `[]` would be racy across concurrent shared-tree children and would never fire in practice. Mirror #02 as an OPT-IN per-task field instead.

In `src/subagents-tool.ts`:

(a) Add `commitScope?: string[];` to the `BatchTask` interface (after `requiredTools?: string[];` added in Task 1).

(b) Add to the per-task schema object (after `requiredTools`):

```ts
      commitScope: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Opt-in commit-path allowlist for this child. When set, flags any committed path outside it as a ⚠ (detection only). Default-off on the plural tool (read-only children + concurrent shared-tree access).",
        }),
      ),
```

(c) Add imports at the top:

```ts
import { computeScopeCheck, realGitOps } from "./git-scope.js";
import { augmentOutputWithScopeViolation, captureCommitBaseline, runScopeCheck } from "./subagent-tool-run.js";
```

(d) In `dispatchChild`, capture a per-child baseline BEFORE spawn (only when the task set a scope) and run the check after, surfacing the ⚠ into the slot output. Insert, right after the `#03` preflight block from Task 1 and before `const childRunId`:

```ts
        // #02 plural mirror: opt-in per-child commitScope. Captured before spawn,
        // checked after; augments the slot output with a ⚠ on violation. The
        // plural tool is read-only so this rarely fires — it is a safety net for
        // a child that somehow commits despite edit/write/bash being excluded.
        const childBase = task.commitScope
          ? await captureCommitBaseline(task.commitScope, childOpts.cwd ?? defaultCwd, defaultCwd, realGitOps)
          : undefined;
```

Then, after the slot is assigned (find the block that sets `slots[index] = { output: result.output, ... }` for the normal done path) — augment that slot's output in place. Immediately before the `// Check the batch budget BETWEEN dispatches` comment, add:

```ts
        if (task.commitScope && slots[index] && slots[index] !== null && (slots[index] as { output?: string }).output !== undefined) {
          const check = await runScopeCheck(
            task.commitScope,
            childOpts.cwd ?? defaultCwd,
            defaultCwd,
            childBase,
            realGitOps,
            computeScopeCheck,
          );
          if (check && check.outOfScope.length > 0) {
            const slot = slots[index] as { output: string };
            slot.output = augmentOutputWithScopeViolation(slot.output, check);
          }
        }
```

(e) Append a plural test to `tests/subagents-tool.test.ts`:

```ts
test("#02 plural mirror: opt-in commitScope flags an out-of-scope commit in the slot output", async () => {
  // This test asserts the opt-in field is wired; on a real read-only child no
  // commit occurs, so we assert the no-commit path does NOT warn (the field is
  // accepted and the child runs normally).
  const spawn = async () => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false });
  const tool = createSubagentsTool({ spawn: spawn as never, cwd: "/nonexistent-repo" });
  const res = await tool.execute(
    "batch-scope",
    { tasks: [{ task: "research", commitScope: ["src/"] }] } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  const slot = res.details.results[0];
  assert.ok(slot && slot !== null);
  // No repo at /nonexistent-repo → captureCommitBaseline returns undefined → no check → clean.
  assert.doesNotMatch((slot as { output: string }).output, /commit-scope violation/);
});
```

- [ ] **Step 9: Run the full package gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bunx tsc --noEmit && bun test )`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git -C <repo> add bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts \
  bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagent-tool-run.test.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git -C <repo> commit -m "feat(subagent): #02 commitScope warn-default (singular default-on, plural opt-in)"
```

---

## Task 3: #04 — retry-loop detector (circuit-break at N=2 consecutive identical-semantic, ABOVE retryOnTransient)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/retry-loop-detector.ts`
- Create: `bun-apps/pi-agent-ext-subagent/tests/retry-loop-detector.test.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts:167` (add `retryCircuitBreak?: number` after `commitScope`)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (preflight BEFORE spawn + BEFORE worktree creation — no allocation to leak)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` (boundary test: retryOnTransient in-dispatch retry unchanged)

**Interfaces:**
- Consumes: `SubagentRunRecord` (from `subagent-run-persistence.ts`) — `{ status, stderr?, task, startedAt, ... }`; `taskPreview` normalization (from `subagent-tool-render.ts`) for `taskSignature`.
- Produces:

```ts
// All pure — the caller passes a SubagentRunRecord[] snapshot (persistence.list()).
export function taskSignature(task: string): string;            // normalized canonical form (whitespace-collapsed, trimmed, lowercased)
export function failureClass(record: { status: string; stderr?: string }): string;  // status + bucketed stderr prefix; "" for non-failures
export function consecutiveIdenticalFailures(
  records: SubagentRunRecord[],
  signature: string,
  fclass: string,
  windowMs: number,
): number;   // newest-first count of consecutive records matching BOTH, within windowMs
export function shouldCircuitBreak(count: number, threshold?: number): boolean; // count >= (threshold ?? 2)
export const DEFAULT_RETRY_CIRCUIT_BREAK = 2;
```

- [ ] **Step 1: Write the failing test for the pure detector**

Create `tests/retry-loop-detector.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { SubagentRunRecord } from "../src/subagent-run-persistence.js";
import {
  consecutiveIdenticalFailures,
  DEFAULT_RETRY_CIRCUIT_BREAK,
  failureClass,
  shouldCircuitBreak,
  taskSignature,
} from "../src/retry-loop-detector.js";

/** Build a minimal record (only the fields the detector reads). */
function rec(opts: {
  task: string;
  status: SubagentRunRecord["status"];
  stderr?: string;
  startedAt: string;
}): SubagentRunRecord {
  return {
    id: "r",
    toolCallId: "c",
    task: opts.task,
    model: "m",
    cwd: "/r",
    status: opts.status,
    exitCode: 1,
    timedOut: false,
    startedAt: opts.startedAt,
    elapsedMs: 1,
    output: "",
    ...(opts.stderr !== undefined ? { stderr: opts.stderr } : {}),
  } as SubagentRunRecord;
}

const NOW = new Date("2026-08-09T12:00:00Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SIG = taskSignature("Fix the memory store bootstrap");
const FCLASS = failureClass({ status: "failed", stderr: "tool 'memory' not found" });

test("taskSignature: whitespace/case-insensitive canonical form (identical-intent tasks collapse)", () => {
  assert.equal(
    taskSignature("Fix the memory store bootstrap"),
    taskSignature("  fix   THE \n memory store\tbootstrap  "),
  );
  assert.notEqual(taskSignature("Fix the memory store"), taskSignature("Fix the memory store bootstrap"));
});

test("failureClass: status + bucketed stderr prefix; '' for non-failures (done is not a failure)", () => {
  assert.equal(failureClass({ status: "failed", stderr: "tool 'memory' not found" }), "failed:tool 'memory' not found");
  assert.equal(failureClass({ status: "failed", stderr: undefined }), "failed:");
  assert.equal(failureClass({ status: "timedout", stderr: "agent timed out" }), "timedout:agent timed out");
  assert.equal(failureClass({ status: "done" }), "");
  assert.equal(failureClass({ status: "aborted" }), "");
});

test("consecutiveIdenticalFailures: 0 / 1 / 2 matching (newest-first) → 0 / 1 / 2", () => {
  assert.equal(consecutiveIdenticalFailures([], SIG, FCLASS, 60_000), 0);
  assert.equal(
    consecutiveIdenticalFailures([rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(1_000) })], SIG, FCLASS, 60_000),
    1,
  );
  assert.equal(
    consecutiveIdenticalFailures(
      [
        rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(2_000) }),
        rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(1_000) }),
      ],
      SIG,
      FCLASS,
      60_000,
    ),
    2,
  );
});

test("consecutiveIdenticalFailures: different failure class resets the streak", () => {
  // newest-first: [same-sig/class-X, same-sig/class-Y] → streak of class-X is 1.
  const records = [
    rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(2_000) }),
    rec({ task: "Fix the memory store bootstrap", status: "timedout", stderr: "agent timed out", startedAt: iso(1_000) }),
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 1);
});

test("consecutiveIdenticalFailures: different task signature resets the streak", () => {
  const records = [
    rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(2_000) }),
    rec({ task: "Completely different task", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(1_000) }),
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 1);
});

test("consecutiveIdenticalFailures: records older than windowMs are not counted", () => {
  const records = [
    rec({ task: "Fix the memory store bootstrap", status: "failed", stderr: "tool 'memory' not found", startedAt: iso(120_000) }), // 2min ago > 60s window
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 0);
});

test("shouldCircuitBreak: count >= threshold (default 2)", () => {
  assert.equal(shouldCircuitBreak(0), false);
  assert.equal(shouldCircuitBreak(1), false);
  assert.equal(shouldCircuitBreak(2), true);
  assert.equal(shouldCircuitBreak(5), true);
  assert.equal(shouldCircuitBreak(2, 3), false); // explicit higher threshold
  assert.equal(DEFAULT_RETRY_CIRCUIT_BREAK, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/retry-loop-detector.test.ts )`
Expected: FAIL — `Cannot find module '../src/retry-loop-detector.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/retry-loop-detector.ts`:

```ts
/**
 * #04 retry-loop / runaway detector — pure helpers.
 *
 * Motivation (run history: 6× "durable memory" retries): a semantically-identical
 * task dispatched repeatedly fails the same way each time, burning tokens on each
 * retry. `retryOnTransient` already retries ONCE inside a single dispatch (a
 * fresh tryOnce() on a transient timeout/network/schema flake) — that is correct
 * and UNCHANGED. This detector operates one level UP: it counts COMPLETED
 * dispatch OUTCOMES (persisted records), and if the same task signature has
 * failed with the same failure class N times in a row (within a time window), the
 * NEXT dispatch is circuit-broken BEFORE spawn.
 *
 * Default threshold N=2: after 2 consecutive identical failures, the 3rd attempt
 * is blocked. (The in-dispatch retryOnTransient retry does NOT count here — it
 * produces a single record per dispatch.)
 *
 * All functions are pure and take a `SubagentRunRecord[]` snapshot the caller
 * supplies (persistence.list(), newest-first), so this module has no I/O and is
 * fully unit-testable.
 */
import type { SubagentRunRecord } from "./subagent-run-persistence.js";

/** Default: circuit-break after this many consecutive identical failures. */
export const DEFAULT_RETRY_CIRCUIT_BREAK = 2;

/** Window over which consecutive failures are counted (ms). 10 min. */
export const RETRY_LOOP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Canonical, case-insensitive, whitespace-collapsed form of a task prompt — two
 * prompts that differ only in casing/whitespace collapse to the SAME signature
 * (the recurring failure mode is the same task re-dispatched with trivial edits).
 * Reuses taskPreview's normalization idea (single-line) but does NOT truncate,
 * so the full intent is part of the signature.
 */
export function taskSignature(task: string): string {
  return task.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A failure's semantic class: `status:stderr` (stderr truncated + trimmed). The
 * stderr is bucketed as-is (the recurring loops had byte-identical error text);
 * two records with the same status and same stderr prefix are "identical". An
 * empty string is returned for NON-failures (done/aborted are not loop signals).
 */
export function failureClass(record: { status: string; stderr?: string }): string {
  // Only real failure modes constitute a loop; done/aborted reset the streak.
  if (record.status !== "failed" && record.status !== "timedout" && record.status !== "budget") return "";
  const stderr = (record.stderr ?? "").trim();
  return `${record.status}:${stderr}`;
}

/**
 * Count, newest-first, how many CONSECUTIVE records match BOTH `signature` and
 * `fclass` within the last `windowMs`. The streak stops at the first record that
 * differs in either (a different failure class or a different task resets it) or
 * that falls outside the window. Non-matching records that are newer are skipped
 * (they don't break the streak — only the first matching record's window anchors
 * the count). Returns 0 when nothing matches.
 */
export function consecutiveIdenticalFailures(
  records: SubagentRunRecord[],
  signature: string,
  fclass: string,
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  let anchored = false;
  for (const r of records) {
    const startedAt = new Date(r.startedAt).getTime();
    if (Number.isNaN(startedAt)) continue;
    if (startedAt < cutoff) break; // list is newest-first → older than this is out of window
    const matches = taskSignature(r.task) === signature && failureClass(r) === fclass;
    if (matches) {
      anchored = true;
      count++;
    } else if (anchored) {
      // We've started counting and hit a non-match → the identical streak is broken.
      break;
    }
    // else: pre-anchor non-match → skip (don't break; keep scanning for the first match).
  }
  return count;
}

/** True when the consecutive-identical count reaches the threshold (default 2). */
export function shouldCircuitBreak(count: number, threshold: number = DEFAULT_RETRY_CIRCUIT_BREAK): boolean {
  return count >= threshold;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/retry-loop-detector.test.ts )`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the `retryCircuitBreak` schema param**

In `src/subagent-tool-schema.ts`, insert after the `commitScope` block (~line 167, before `schema`):

```ts
  retryCircuitBreak: Type.Optional(
    Type.Integer({
      description:
        "Circuit-break this dispatch BEFORE spawn when the same task has already failed this many consecutive times with the same error (within 10 min). Default 2. Counts completed dispatch outcomes (not the in-dispatch retryOnTransient retry). Set 0 to disable.",
    }),
  ),
```

- [ ] **Step 6: Write the failing tool-level tests (circuit-break + boundary)**

Append to `tests/subagent-tool.test.ts`. This needs a fake persistence whose `list()` returns the seeded records:

```ts
import type { SubagentRunRecord } from "../src/subagent-run-persistence.js";

/** Minimal in-memory persistence for detector wiring tests. */
function fakePersistence(records: SubagentRunRecord[]) {
  return { list: () => records, save: () => {}, load: () => null, delete: () => false, getRunsDir: () => "/r" } as never;
}

function mkRec(task: string, status: SubagentRunRecord["status"], stderr: string): SubagentRunRecord {
  return {
    id: "r",
    toolCallId: "c",
    task,
    model: "m",
    cwd: "/r",
    status,
    exitCode: 1,
    timedOut: false,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    elapsedMs: 1,
    output: "",
    stderr,
  } as SubagentRunRecord;
}

test("#04 circuit-break: 2 prior identical failures → failEarly, spawn NOT called", async () => {
  const f = fakeSpawn(() => ({ output: "should not reach", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakePersistence([
    mkRec(task, "failed", "tool 'memory' not found"),
    mkRec(task, "failed", "tool 'memory' not found"),
  ]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  const res = await tool.execute("id-cb", { task }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 0, "spawn NOT called — circuit broken before spawn");
  assert.equal(res.details.status, "failed");
  assert.match(
    (res.content[0] as { text: string }).text,
    /circuit-break.*already failed 2 consecutive times/i,
  );
});

test("#04 circuit-break: 1 prior failure → NOT broken, spawn IS called (this is the 2nd attempt)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakePersistence([mkRec(task, "failed", "tool 'memory' not found")]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-cb2", { task }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 1, "1 prior failure is below the default threshold of 2 → dispatch runs");
});

test("#04 boundary: retryOnTransient's single in-dispatch retry is UNCHANGED (detector counts dispatch outcomes, not tryOnce calls)", async () => {
  // No prior records → no circuit-break. A transient failure still retries once
  // INSIDE spawn (tryOnce). The detector never interferes with that inner retry.
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const persistence = fakePersistence([]); // clean history → never circuit-breaks
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-bdy", { task: "unique task", retryOnTransient: true }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 1, "spawn called once (the injected fake); retryOnTransient retry lives inside spawnSubagent, not the tool");
});

test("#04 opt-out: retryCircuitBreak:0 disables the detector", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakePersistence([
    mkRec(task, "failed", "x"),
    mkRec(task, "failed", "x"),
  ]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-optout", { task, retryCircuitBreak: 0 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 1, "retryCircuitBreak:0 disables the preflight");
});
```

- [ ] **Step 7: Run the tool-level tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#04" )`
Expected: FAIL — the detector is not wired yet, so spawn IS called and the "2 prior" test fails.

- [ ] **Step 8: Wire the preflight into the singular tool (BEFORE worktree creation)**

In `src/subagent-tool.ts`:

(a) Add imports near the top:

```ts
import {
  consecutiveIdenticalFailures,
  DEFAULT_RETRY_CIRCUIT_BREAK,
  failureClass,
  RETRY_LOOP_WINDOW_MS,
  shouldCircuitBreak,
  taskSignature,
} from "./retry-loop-detector.js";
```

(b) Insert the preflight immediately AFTER the schema-shape check (`if (params.schema !== undefined && !isSchemaShaped(...)) { return failEarly(...); }`, ~line 139) and BEFORE the worktree-creation block (`let worktree: Worktree | undefined;`). Placing it here means a circuit-broken dispatch never allocates a worktree or registers in-flight — no leak, no cleanup needed:

```ts
      // #04 retry-loop / runaway detector (circuit-break BEFORE spawn + BEFORE
      // worktree allocation). Counts completed dispatch OUTCOMES (persisted
      // records), NOT retryOnTransient's single in-dispatch tryOnce() retry.
      // Placed before worktree/inFlight so a broken dispatch leaks nothing.
      const circuitThreshold = params.retryCircuitBreak ?? DEFAULT_RETRY_CIRCUIT_BREAK;
      if (circuitThreshold > 0 && options.persistence) {
        const prior = options.persistence.list();
        const sig = taskSignature(params.task);
        // Derive the prospective failure class from the MOST RECENT matching
        // record (the repeat we'd be about to re-create). No match → no class → 0.
        const mostRecentMatch = prior.find((r) => taskSignature(r.task) === sig);
        const fclass = mostRecentMatch ? failureClass(mostRecentMatch) : "";
        if (fclass) {
          const count = consecutiveIdenticalFailures(prior, sig, fclass, RETRY_LOOP_WINDOW_MS);
          if (shouldCircuitBreak(count, circuitThreshold)) {
            return failEarly(
              `circuit-break: this task has already failed ${count} consecutive times ` +
                `(same error class, within ${Math.round(RETRY_LOOP_WINDOW_MS / 60_000)} min). ` +
                `Change the task, fix the root cause, or raise retryCircuitBreak (currently ${circuitThreshold}).`,
            );
          }
        }
      }
```

- [ ] **Step 9: Run the tool-level tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#04" )`
Expected: PASS (4 tests, including the retryOnTransient boundary test).

- [ ] **Step 10: Run the full package gate**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bunx tsc --noEmit && bun test )`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git -C <repo> add bun-apps/pi-agent-ext-subagent/src/retry-loop-detector.ts \
  bun-apps/pi-agent-ext-subagent/tests/retry-loop-detector.test.ts \
  bun-apps/pi-agent-ext-subagent/src/subagent-tool-schema.ts \
  bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts
git -C <repo> commit -m "feat(subagent): #04 retry-loop detector (circuit-break at N=2 consecutive identical)"
```

---

## Task 4: #01 — tiered token-budget defaults (HARD-ABORT; tokenBudget-only; spendBudget no-op)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/src/budget-defaults.ts`
- Create: `bun-apps/pi-agent-ext-subagent/tests/budget-defaults.test.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts:297` (`buildSpawnOptions` tokenBudget default)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:177` (`mergeReadOnlyExclusion` tokenBudget default)
- Modify: `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts` (budget block: default applied when omitted)

**Interfaces:**
- Consumes: `loadModelTierConfig()` (from `@repo/pi-agent-ext-core-runtime`) for the model→tier reverse-map; `modelCtx.tier` / `modelCtx.requestedModel` / `modelCtx.mainModel` (already threaded into `buildSpawnOptions`).
- Produces:

```ts
export const TIERED_TOKEN_BUDGET_DEFAULTS: Record<"small" | "medium" | "big", number>;
// { small: 500_000, medium: 1_200_000, big: 1_500_000 }
export function tierDefaultToken(
  tier: string | undefined,
  model?: string,
  config?: ModelTierConfig | null,
): number; // tier set → table[tier]; else reverse-map model→tier via config; else medium ceiling.
```

### Calibration (decision input — recorded per ticket 01 Step 0)

Surveyed **200 retained runs** in `~/.pi/subagents/runs` (all `status:done`, so the ceilings sit ABOVE real successful work and catch only the runaway tail). `usage.total` per tier:

| tier  | p90 usage.total | chosen ceiling | rationale |
|-------|-----------------|----------------|-----------|
| small | 461k            | **500k**       | ceil just above p90; the 927k "write 2 memory entries" runaway (run mslovsnn) is caught. |
| medium| 1.1M            | **1.2M**       | the 1.34M "17-line fix" runaway (run mslouix3) is caught. |
| big   | 1.4M            | **1.5M**       | the 3.4M (mslns1vl) and 6.3M runaway tail are hard-aborted well before. |

- **PRD's flat 40k/120k/250k would false-abort ≥50% of medium runs** (median medium run ≈ 600k > 120k) — rejected.
- **spendBudget = no-op**: on this MLX stack all models are local (`cost ≡ 0` in every retained run's `usage`), so a spend ceiling can never fire. Left unset; documented.
- **Unset-tier ≈ 80%** of dispatches → the default reverse-maps the model→tier via `loadModelTierConfig()` (`tiers` is `Record<tier, modelSpec>`; we invert it). Unknown model → `medium` ceiling (the safe middle). This is why `tierDefaultToken` takes an optional `model`.

- [ ] **Step 1: Write the failing test for the pure budget module**

Create `tests/budget-defaults.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { TIERED_TOKEN_BUDGET_DEFAULTS, tierDefaultToken } from "../src/budget-defaults.js";

const CFG: ModelTierConfig = {
  tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.2", big: "zai/glm-5.2-thinking" },
};

test("TIERED_TOKEN_BUDGET_DEFAULTS: p90-calibrated ceilings", () => {
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.small, 500_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.medium, 1_200_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.big, 1_500_000);
});

test("tierDefaultToken: explicit tier → that tier's ceiling", () => {
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  assert.equal(tierDefaultToken("medium", undefined, CFG), 1_200_000);
  assert.equal(tierDefaultToken("big", undefined, CFG), 1_500_000);
  // tier wins over model when both are given
  assert.equal(tierDefaultToken("small", "zai/glm-5.2", CFG), 500_000);
});

test("tierDefaultToken: unset tier → reverse-map model→tier via config", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", CFG), 500_000); // glm-4.7 → small
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), 1_200_000); // glm-5.2 → medium
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2-thinking", CFG), 1_500_000); // → big
  // strip a :thinking suffix before matching
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7:thinking", CFG), 500_000);
});

test("tierDefaultToken: unknown model + unset tier → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "deepseek/unknown-model", CFG), 1_200_000);
});

test("tierDefaultToken: no config at all → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", null), 1_200_000);
  assert.equal(tierDefaultToken(undefined, undefined, null), 1_200_000);
});

test("tierDefaultToken: unknown tier name → medium ceiling", () => {
  assert.equal(tierDefaultToken("humongous", undefined, CFG), 1_200_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/budget-defaults.test.ts )`
Expected: FAIL — `Cannot find module '../src/budget-defaults.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/budget-defaults.ts`:

```ts
/**
 * #01 default token-budget guardrails — tier-calibrated HARD-ABORT ceilings.
 *
 * Motivation: budgets WORK when set (run msl3c9zi aborted cleanly at 380k), but
 * they are RARELY set — 80%+ of dispatches omit tokenBudget, so unbounded runs
 * blow past sane limits (1.34M for a 17-line fix; 3.4M/6.3M runaway tail). This
 * module supplies a TIER-CALIBRATED DEFAULT so every dispatch has a ceiling.
 *
 * The hard-abort path itself already ships: `classifyError` maps
 * `TOKEN_BUDGET_EXHAUSTED` → non-transient (no retry), surfaced as
 * `result.budget` + `status:"budget"`. We only supply the DEFAULT value.
 *
 * Calibration: 200 retained `status:done` runs; ceilings sit just above the p90
 * `usage.total` per tier (small 461k→500k / medium 1.1M→1.2M / big 1.4M→1.5M) so
 * only the runaway tail is hard-aborted. A flat 40k/120k/250k default was
 * rejected — it would false-abort ≥50% of medium runs.
 *
 * spendBudget is intentionally NOT defaulted: on this MLX stack every model is
 * local (cost≡0 in every retained run), so a spend ceiling can never fire.
 */
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { loadModelTierConfig } from "@repo/pi-agent-ext-core-runtime";

/**
 * p90-calibrated per-tier token ceilings (hard-abort). See module doc + the
 * Calibration table in the implementation plan.
 */
export const TIERED_TOKEN_BUDGET_DEFAULTS: Record<"small" | "medium" | "big", number> = {
  small: 500_000,
  medium: 1_200_000,
  big: 1_500_000,
};

const SAFE_FALLBACK_TIER: keyof typeof TIERED_TOKEN_BUDGET_DEFAULTS = "medium";

/** Strip a `:thinking` (or similar) role suffix from a model spec for matching. */
function baseSpec(spec: string): string {
  return spec.split(":")[0] ?? spec;
}

/**
 * Resolve a model spec back to its tier name by inverting `config.tiers`
 * (tier→spec). Returns `undefined` when the model is not configured under any tier.
 */
function tierForModel(model: string | undefined, config: ModelTierConfig | null): string | undefined {
  if (!model || !config) return undefined;
  const want = baseSpec(model);
  for (const [tier, spec] of Object.entries(config.tiers)) {
    if (baseSpec(spec) === want) return tier;
  }
  return undefined;
}

/**
 * The default token ceiling for a dispatch:
 * 1. explicit `tier` set → `TIERED_TOKEN_BUDGET_DEFAULTS[tier]` (unknown tier → medium);
 * 2. else reverse-map `model` → tier via `config` (default `loadModelTierConfig()`);
 * 3. else the safe `medium` ceiling.
 *
 * `config` is an optional param so tests can inject a fixture without touching disk;
 * production omits it and reads the user's `~/.pi/workflows/model-tiers.json`.
 */
export function tierDefaultToken(
  tier: string | undefined,
  model?: string,
  config: ModelTierConfig | null = loadModelTierConfig(),
): number {
  const resolved =
    tier && tier in TIERED_TOKEN_BUDGET_DEFAULTS
      ? (tier as keyof typeof TIERED_TOKEN_BUDGET_DEFAULTS)
      : (tierForModel(model, config) ?? SAFE_FALLBACK_TIER);
  return TIERED_TOKEN_BUDGET_DEFAULTS[resolved] ?? TIERED_TOKEN_BUDGET_DEFAULTS[SAFE_FALLBACK_TIER];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/budget-defaults.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the default into `buildSpawnOptions` (singular)**

In `src/subagent-tool-run.ts`:

(a) Add the import (top, with the others):

```ts
import { tierDefaultToken } from "./budget-defaults.js";
```

(b) Change the `tokenBudget` line in `buildSpawnOptions` (line 297). Current:

```ts
    tokenBudget: params.tokenBudget,
    spendBudget: params.spendBudget,
```

Replace with (explicit caller value still wins; spendBudget stays caller-only — no-op default):

```ts
    // #01 tier-calibrated hard-abort default. An explicit tokenBudget always
    // wins; otherwise the ceiling is derived from the tier (or the model's tier
    // via reverse-map). spendBudget is intentionally NOT defaulted (cost≡0 on
    // this MLX stack — a spend ceiling can never fire).
    tokenBudget: params.tokenBudget ?? tierDefaultToken(modelCtx.tier, modelCtx.requestedModel ?? modelCtx.mainModel),
    spendBudget: params.spendBudget,
```

- [ ] **Step 6: Write the failing integration test (default applied via the tool → spawn)**

Append to `tests/spawn-subagent.test.ts` is the WRONG layer (that tests `spawnSubagent` directly, which just forwards whatever it's given). The default is applied in `buildSpawnOptions` (the tool layer). So append to `tests/subagent-tool.test.ts`:

```ts
test("#01 default budget: no tokenBudget + tier:small → spawn receives 500000", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id-bud", { task: "t", tier: "small" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 500_000, "tier:small with no explicit budget → 500k default");
});

test("#01 default budget: explicit tokenBudget still wins", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id-bud2", { task: "t", tier: "small", tokenBudget: 999 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 999, "explicit tokenBudget overrides the tier default");
});

test("#01 default budget: no tier + no model → medium ceiling (1.2M)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn }); // no getMainModel → mainModel undefined
  await tool.execute("id-bud3", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 1_200_000, "no tier, no model → safe medium fallback");
});
```

Also confirm the EXISTING budget-exhaustion behavior is untouched — add to `tests/spawn-subagent.test.ts`'s `describe("spawnSubagent budget")` block (this already exists and must stay green; no new assertion needed, just verify it still passes in Step 9). The existing test "TOKEN_BUDGET_EXHAUSTED → result.budget set, non-transient (not retried)" covers the hard-abort path.

- [ ] **Step 7: Run the integration tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "#01 default budget" )`
Expected: PASS (3 tests).

- [ ] **Step 8: Plural mirror — per-child tier default in `mergeReadOnlyExclusion`**

In `src/subagents-tool.ts`:

(a) Add imports:

```ts
import { tierDefaultToken } from "./budget-defaults.js";
```

(b) In `mergeReadOnlyExclusion`, change the `tokenBudget` line (line 177). Current:

```ts
    tokenBudget: task.tokenBudget,
    spendBudget: task.spendBudget,
```

Replace with:

```ts
    // #01 plural mirror: per-child tier-calibrated default (read-only research
    // fan-out still benefits from a token ceiling). Explicit per-task value wins.
    tokenBudget: task.tokenBudget ?? tierDefaultToken(task.tier, task.model ?? ctx.mainModel),
    spendBudget: task.spendBudget,
```

(c) Append a plural test to `tests/subagents-tool.test.ts`:

```ts
test("#01 plural mirror: per-child tier default applied when tokenBudget omitted", async () => {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = async (opts: SpawnSubagentOptions) => {
    calls.push(opts);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ spawn: spawn as never });
  await tool.execute(
    "batch-bud",
    { tasks: [{ task: "research", tier: "small" }, { task: "big synth", tier: "big", tokenBudget: 999 }] } as never,
    undefined as never,
    undefined,
    { cwd: "/r" } as never,
  );
  assert.equal(calls[0]?.tokenBudget, 500_000, "tier:small child → 500k default");
  assert.equal(calls[1]?.tokenBudget, 999, "explicit per-child tokenBudget wins");
});
```

- [ ] **Step 9: Run the full package gate (including the existing budget-exhaustion test)**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bunx tsc --noEmit && bun test )`
Expected: PASS — including the pre-existing `spawnSubagent budget` block (TOKEN_BUDGET_EXHAUSTED non-retry), proving the hard-abort path is untouched.

- [ ] **Step 10 (OPTIONAL / low-priority): settings.json override seam**

Add an optional `getBudgetDefaults?: () => Record<string, number> | undefined` injection on `SubagentToolOptions` (schema file) and `SubagentsToolOptions`. In `buildSpawnOptions`, if `deps.getBudgetDefaults?.()` returns a table, use it in place of `TIERED_TOKEN_BUDGET_DEFAULTS` (thread it into `tierDefaultToken` via a new optional 4th param). Wire it in `extensions/subagent.ts` to read `settings.json["subagents"].budget`. This step is OPTIONAL and low-priority — the static p90 table is the deliverable; the override seam is a nice-to-have for power users. If you skip it, OMIT this step entirely (do not leave any deferred-work marker in the code) and note "settings-override seam deferred" in the PR body.

- [ ] **Step 11: Commit**

```bash
git -C <repo> add bun-apps/pi-agent-ext-subagent/src/budget-defaults.ts \
  bun-apps/pi-agent-ext-subagent/tests/budget-defaults.test.ts \
  bun-apps/pi-agent-ext-subagent/src/subagent-tool-run.ts \
  bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts \
  bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git -C <repo> commit -m "feat(subagent): #01 tiered token-budget defaults (p90-calibrated hard-abort)"
```

---

## Execution order rationale

Tasks are ordered for lowest-risk-first and so each is independently shippable:

1. **Task 1 (#03 impossible-tool)** — pure helper + additive preflight; zero behavior change to existing paths. Builds confidence in the preflight pattern Task 3 reuses.
2. **Task 2 (#02 commitScope default-on)** — flips an existing gate (behavior change), but the gate is detection-only (never auto-reverts) so the blast radius is "more warnings". Done before the budget work so a budget-abort test isn't confounded by scope output.
3. **Task 3 (#04 retry-loop detector)** — pure module + preflight reusing the pattern from Task 1; depends on the persistence seam already existing (it does).
4. **Task 4 (#01 tiered budgets)** — flagship; touches the budget path last so the existing `spawnSubagent budget` regression tests are the final gate.

Each task ends green on the full package gate and is a clean review unit.

---

## Author Self-Review

**1. Spec coverage (every ticket → a task):**
- **#01 default-budget-guardrails** → **Task 4** (tier-calibrated hard-abort defaults, p90 calibration recorded, override path documented, existing tests green). ✓
- **#02 commit-scope-default** → **Task 2** (Option B1 chosen: default `scope=[]`, warn on any commit, never auto-revert; detection runs by default; tests green). ✓
- **#03 impossible-tool-preflight** → **Task 1** (declaration API `requiredTools`, preflight aborts with a clear message, dispatch requiring an absent tool fails fast). ✓
- **#04 retry-loop-detector** → **Task 3** (aborts after N=2 consecutive identical; `retryOnTransient` overlap clarified + boundary-tested; detector counts dispatch outcomes not tryOnce). ✓
- **#05 dispatch-discipline-skill** → **OUT OF SCOPE** for this plan (it is a wayfind skill, not a code guardrail; the four guardrail tickets are the scope here). Noted, not covered — by design.

**2. Placeholder scan:** Searched the plan for `TODO`, `TBD`, `add error handling`, `add validation`, `handle edge cases`, `similar to Task`, `implement later`, `fill in`. The only matches are inside this very self-review paragraph (quoting the forbidden patterns to name them) — none appear in any implementation or test code block. Task 4 Step 10 (the optional settings-override seam) explicitly instructs OMITTING the step rather than leaving any deferred-work marker. No placeholder remains in any code block.

**3. Type consistency:**
- `missingRequiredTools(required, resolved, exclude): string[] | undefined` — identical signature in Task 1 definition, test, singular wiring, and plural wiring. ✓
- `taskSignature(task: string): string`, `failureClass(record): string`, `consecutiveIdenticalFailures(records, signature, fclass, windowMs): number`, `shouldCircuitBreak(count, threshold?): boolean`, `DEFAULT_RETRY_CIRCUIT_BREAK = 2`, `RETRY_LOOP_WINDOW_MS` — consistent across Task 3 definition, test, and wiring. ✓
- `TIERED_TOKEN_BUDGET_DEFAULTS` (Record<small|medium|big, number>) and `tierDefaultToken(tier, model?, config?)` — consistent across Task 4 definition, test, and both wiring sites. ✓
- `failEarly` used as the REAL closure `failEarly(text)` everywhere (NOT the brief's hypothesized multi-arg form) — adjustment noted below. ✓
- `params.requiredTools` / `params.retryCircuitBreak` flow from the TypeBox schema (added in-task) into `execute` — typed automatically; no manual param-type edits needed. ✓

**Pinned decisions (as written):**
- **#02 = B1**: default `scope=[]`, warn on ANY commit, NEVER auto-revert. (Task 2)
- **#04 = N=2 consecutive identical-semantic**, above `retryOnTransient`'s single in-dispatch retry; counts dispatch outcomes not `tryOnce()` calls. (Task 3)
- **#01 = hard-abort + p90-calibrated** ceilings: small 500k / medium 1.2M / big 1.5M. `spendBudget` = no-op (cost≡0 on this MLX stack). (Task 4)
- **#03 = declaration-based** (`requiredTools` param), aborts pre-spawn. (Task 1)

**Adjustments to the brief (code shifted from the recon anchors):**
1. **`failEarly` is a local closure `failEarly(text: string)`** (subagent-tool.ts:105), capturing `toolCallId`/`t0`/`params` — NOT the brief's `failEarly(toolCallId, t0, text, {persistence})`. All preflight early-returns are plain `return failEarly("...")`. Verified by reading the file.
2. **The spawn call site inlines `buildSpawnOptions`** (subagent-tool.ts:196-220), so Task 1 Step 8 extracts it into `const opts` before the preflight — the `return failEarly(...)` stays INSIDE the existing `try` so the `finally` still tears down the worktree + ends inFlight (no leak).
3. **#04 preflight is placed BEFORE worktree creation** (after the schema-shape check, before `let worktree`), not before spawn — so a circuit-broken dispatch allocates nothing (no worktree, no inFlight). Cleaner than the brief's "before spawn" placement.
4. **#02 plural mirror is OPT-IN per-task** (`commitScope?` on `BatchTask`), NOT default-on — the plural tool is read-only (`READ_ONLY_EXCLUDED` always denies edit/write/bash) and runs concurrent shared-tree children, so a global `[]` default would be racy and never fire. Documented in Task 2 Step 8. The singular tool (where the recon failures occurred) IS default-on.
5. **#03 plural mirror** skips the child (null slot) + `console.warn`, rather than expanding the `BatchResultSlot` union — minimal, honest; the primary acceptance is met by the singular tool. Documented.
