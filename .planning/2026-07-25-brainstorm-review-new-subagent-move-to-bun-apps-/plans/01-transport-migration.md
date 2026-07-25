# Child-execution transport migration (ticket 02) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every `execChildPrompt` (bespoke `pi -p` subprocess) caller in `pi-agent-ext-hermes-memory` to the shared `spawnSubagent` runner, then delete the now-dead `pi-child-process.ts` subsystem.

**Architecture:** Uniform migration — consolidation, the background-review subprocess fallback, correction-detector, and session-flush all dispatch via `spawnSubagent` (small tier) instead of `execChildPrompt`. The child gets the `memory` tool via `extensionTools` bridging (a small `registerMemoryTool` refactor exposes the `ToolDefinition`; its `execute` closure binds the parent's `MemoryStore`, and since `spawnSubagent` is in-process the child's writes land in the parent store — same effect as today's `-e` subprocess). `direct` transport (`completeSimple`) survives ONLY as background-review's default (high frequency). Import via the `src/` subpath so migrated runs appear in the `/subagents` viewer. Backend-neutrality preserved.

**Tech Stack:** TypeScript + Bun; `@repo/pi-agent-ext-subagent` (`spawnSubagent`, `WorkflowAgent`); typebox; the hermes-memory `MemoryStore`/`MemoryRepository`.

## Global Constraints
- `execChildPrompt`'s result `{ code, stdout, stderr, killed }` maps to `spawnSubagent`'s `{ output, exitCode, stderr, timedOut, usage? }`: `code === 0` → `exitCode === 0`; `stdout` → `output`.
- Import `spawnSubagent` from the **`src/` subpath**: `import { spawnSubagent } from "@repo/pi-agent-ext-subagent/src/index.ts";` (module-identity rule — matches `pi-agent-ext-workflow`'s pattern, so runs hit the shared `/subagents`-viewer singletons). Do NOT use the bare `.` root (it resolves to `dist/` → private singleton → runs invisible).
- Add `"@repo/pi-agent-ext-subagent": "workspace:*"` to `peerDependencies` (matches `pi-agent-ext-knowledge-card`'s post-#789 pattern).
- Never top-level `cd`; run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. `biome check` is the package gate (green here, unlike workflow).
- Consolidation/review/flush/correction write via the **backend-neutral** `MemoryStore`/`MemoryRepository` — no SQLite/Surreal hardcoding.
- Pre-existing `@types/node` tsc noise elsewhere is environmental; only NEW errors referencing changed symbols matter.

## File Structure
| File | Action |
|---|---|
| `package.json` | Add `@repo/pi-agent-ext-subagent` peerDep. |
| `src/tools/memory-tool.ts` | Refactor `registerMemoryTool` to also **return** the `ToolDefinition` (bridging enabler). |
| `src/index.ts` | Capture the returned tool def; thread it into the consolidator closure + the migrated handlers. |
| `src/handlers/auto-consolidate.ts` | `triggerConsolidation` → `spawnSubagent`. |
| `src/handlers/background-review.ts` | `runSubprocessReview` → spawnSubagent-based; delete `buildSubprocessReviewPrompt`. |
| `src/handlers/correction-detector.ts` | `execChildPrompt` → `spawnSubagent`. |
| `src/handlers/session-flush.ts` | `execChildPrompt` → `spawnSubagent`. |
| `src/handlers/pi-child-process.ts` | **DELETE** (entire file). |
| `src/types.ts` / `src/config.ts` | Narrow `ReviewTransport` (drop `subprocess`). |
| `tests/handlers/{auto-consolidate,background-review,correction-detector,session-flush,pi-child-process}.test.ts` | Update/remove per task. |

---

## Task 1: Add subagent dep + expose the memory-tool definition (bridging enabler)

**Files:**
- Modify: `package.json` (peerDependencies)
- Modify: `src/tools/memory-tool.ts` (`registerMemoryTool`)
- Modify: `src/index.ts` (capture the def)
- Test: `tests/tools/memory-tool.test.ts`

**Interfaces:**
- Produces: `registerMemoryTool(...)` now returns `ToolDefinition` (the `{name,label,description,parameters,execute}` object). Callers capture it as `const memoryToolDef = registerMemoryTool(pi, store, ...)`.

- [ ] **Step 1: Add the dependency**

In `package.json`, add to `peerDependencies` (keep existing entries, add the subagent line):
```json
  "peerDependencies": {
    "@earendil-works/pi-ai": "0.82.0",
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@repo/pi-agent-ext-subagent": "workspace:*"
  },
```
Then `( cd bun-apps && bun install )` to refresh `bun.lock`.

- [ ] **Step 2: Write the failing test** — `registerMemoryTool` returns a usable ToolDefinition

In `tests/tools/memory-tool.test.ts`, add:
```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

it("registerMemoryTool returns the memory ToolDefinition for bridging", () => {
  const pi = makeFakePi(); // existing helper in this file
  const store = new MemoryStore(tmpdir());
  const def = registerMemoryTool(pi, store, null);
  assert.ok(def, "registerMemoryTool must return the ToolDefinition");
  assert.equal(def.name, "memory");
  assert.equal(typeof def.execute, "function");
  // sanity: it is the same shape the host received
  assert.equal(pi.registeredTools["memory"]?.name, "memory");
});
```
(If `makeFakePi` records into `registeredTools`, reuse it; otherwise capture via the `pi.registerTool` mock the file already uses.)

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-tool.test.ts -t "returns the memory ToolDefinition" )`
Expected: FAIL — `registerMemoryTool` currently returns `void`.

- [ ] **Step 4: Refactor `registerMemoryTool` to return the def**

In `src/tools/memory-tool.ts`, extract the definition object into a `const`, pass it to `pi.registerTool`, and return it. Change the signature from `): void {` to `): ToolDefinition {` and:
```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
// ...
export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  memoryRepo: MemoryRepository | null = null,
  projectName?: string | null,
): ToolDefinition {
  const definition: ToolDefinition = {
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: Type.Object({ /* …existing parameters verbatim… */ }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      /* …existing execute body verbatim… */
    },
  };
  pi.registerTool(definition);
  return definition;
}
```
(Keep the `parameters` and `execute` body byte-identical to today — only the wrapping changes.)

- [ ] **Step 5: Run the test + full file**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-tool.test.ts )`
Expected: all PASS incl. the new test.

> **Do NOT touch `src/index.ts` in this task.** It still calls `registerMemoryTool(pi, store, …);` as a statement — the new return value is harmlessly ignored, so there is no unused-variable failure. The capture + first use of the returned def happens together in Task 2 (avoids a standalone commit with an unused `memoryToolDef`).

- [ ] **Step 6: Commit**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/package.json bun-apps/bun.lock \
        bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/tools/memory-tool.test.ts
git commit -m "feat(hermes-memory): expose memory-tool ToolDefinition for subagent bridging"
```

---

## Task 2: Migrate consolidation → spawnSubagent

**Files:**
- Modify: `src/handlers/auto-consolidate.ts` (`triggerConsolidation` + the `registerConsolidateCommand` model-label use)
- Modify: `src/index.ts` (pass `memoryToolDef` into the consolidator closure)
- Test: `tests/handlers/auto-consolidate.test.ts`

**Interfaces:**
- Consumes: `memoryToolDef: ToolDefinition` (from Task 1), `spawnSubagent` from `@repo/pi-agent-ext-subagent/src/index.ts`.
- Produces: `triggerConsolidation` no longer takes `pi`; it takes `memoryToolDef` and calls `spawnSubagent`.

- [ ] **Step 1: Write the failing test** — consolidation dispatches via spawnSubagent (mocked)

In `tests/handlers/auto-consolidate.test.ts`, add/adjust a test that injects a fake `spawnSubagent` and asserts consolidation calls it with `tier: "small"`, `tools: ["memory"]`, `extensionTools: [memoryToolDef]`, and maps `exitCode === 0` → `{ consolidated: true }`. The existing tests inject `execChild` via deps — replace that seam: add a `deps.spawn?: typeof spawnSubagent` injection point to `triggerConsolidation` (production omits → real `spawnSubagent`).

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/auto-consolidate.test.ts )`
Expected: FAIL (still calls `execChildPrompt`).

- [ ] **Step 3: Migrate `triggerConsolidation`**

In `src/handlers/auto-consolidate.ts`:
- Replace `import { execChildPrompt } from "./pi-child-process.js";` with `import { spawnSubagent } from "@repo/pi-agent-ext-subagent/src/index.ts";` and `import type { ToolDefinition } from "@earendil-works/pi-coding-agent";`.
- Change the signature — drop `pi`, add `memoryToolDef` + an injectable `spawn` for tests:
```ts
export async function triggerConsolidation(
  store: MemoryStore,
  target: MemoryTarget,
  memoryToolDef: ToolDefinition,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  spawn: typeof spawnSubagent = spawnSubagent,
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);
  const prompt = [
    CONSOLIDATION_PROMPT, "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    currentContent || "(empty)", "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ].join("\n");

  try {
    const result = await spawn({
      task: prompt,
      tier: "small",
      instructions: "You are a memory consolidator. Use ONLY the memory tool to merge/dedup entries as instructed. Do not read or modify any files.",
      tools: ["memory"],
      extensionTools: [memoryToolDef],
      timeoutMs,
      externalSignal: signal,
      retryOnTransient: true,
    });
    if (result.exitCode === 0) {
      store.loadFromDisk(); // mirror today's post-child reload
      return { consolidated: true };
    }
    return { consolidated: false, error: describeConsolidationFailure(result, timeoutMs) };
  } catch (err) {
    return { consolidated: false, error: `Consolidation failed: ${String(err).slice(0, 200)}` };
  }
}
```
- Update `describeConsolidationFailure` to read `SpawnSubagentResult` (`result.stderr`/`result.timedOut`) instead of `result.code`/`result.killed`.

- [ ] **Step 4: Capture the def + update `src/index.ts` callers**

In `src/index.ts`, change the `registerMemoryTool(…)` statement to capture the returned def (this is the first use — no unused variable):
```ts
const memoryToolDef = registerMemoryTool(pi, store, projectStore, memoryRepo, projectName);
```
The consolidator closure (the `return triggerConsolidation(pi, store, …)` at ~L298/L303) becomes `return triggerConsolidation(store, target, memoryToolDef, signal, config.consolidationTimeoutMs, target, config);` (drop `pi`, add `memoryToolDef`). Pass `memoryToolDef` into `registerConsolidateCommand(…)` likewise.

- [ ] **Step 5: Run tests + typecheck**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/auto-consolidate.test.ts && bunx tsc --noEmit )`
Expected: PASS; no new tsc errors.

- [ ] **Step 6: Commit**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/auto-consolidate.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/auto-consolidate.test.ts
git commit -m "refactor(hermes-memory): consolidation via spawnSubagent (subprocess→shared runner)"
```

---

## Task 3: Migrate review-fallback + correction-detector + session-flush → spawnSubagent

**Files:**
- Modify: `src/handlers/background-review.ts` (`runSubprocessReview`, delete `buildSubprocessReviewPrompt`)
- Modify: `src/handlers/correction-detector.ts`
- Modify: `src/handlers/session-flush.ts`
- Modify: `src/index.ts` (thread `memoryToolDef` into `setupBackgroundReview`/`setupCorrectionDetector`/`setupSessionFlush` deps)
- Test: `tests/handlers/{background-review,correction-detector,session-flush}.test.ts`

**Interfaces:**
- Consumes: `memoryToolDef` (Task 1), `spawnSubagent`.
- Produces: the three handlers' `execChildPrompt` calls become `spawnSubagent` calls; `runSubprocessReview` is spawn-based; `buildSubprocessReviewPrompt` is deleted.

- [ ] **Step 1: background-review — convert `runSubprocessReview`**

In `src/handlers/background-review.ts`, replace the `execChildPrompt` import with the `spawnSubagent` src-subpath import. Rewrite `runSubprocessReview` to dispatch via spawnSubagent (it is the fallback when `direct` fails; the child saves via the bridged memory tool, same as today's subprocess):
```ts
async function runSubprocessReview(
  prompt: string,
  memoryToolDef: ToolDefinition,
  config: MemoryConfig,
  spawn: typeof spawnSubagent,
): Promise<{ code: number; stdout?: string }> {
  const result = await spawn({
    task: prompt,
    tier: "small",
    instructions: "You are a memory reviewer. Use ONLY the memory tool to save notable facts as instructed. Do not read or modify files.",
    tools: ["memory"],
    extensionTools: [memoryToolDef],
    timeoutMs: 120000,
    retryOnTransient: true,
  });
  return { code: result.exitCode, stdout: result.output };
}
```
Delete `buildSubprocessReviewPrompt` (L37) and the `subprocessPrompt` build at L192 — the spawn task is the review prompt directly. Thread `memoryToolDef` + an injectable `spawn` through `setupBackgroundReview`'s `options.deps`. Update the call site at L226 to the new signature.

- [ ] **Step 2: correction-detector — swap the call**

In `src/handlers/correction-detector.ts`, replace the `execChildPrompt` import with the `spawnSubagent` import. At ~L220:
```ts
const result = await spawn({
  task: prompt.join("\n"),
  tier: "small",
  instructions: "Use ONLY the memory tool to save the correction as instructed. Do not read or modify files.",
  tools: ["memory"],
  extensionTools: [memoryToolDef],
  timeoutMs: 30000,
  externalSignal: ctx.signal,
  retryOnTransient: true,
});
if (result.exitCode === 0 && result.output) {
  const output = result.output.trim();
  if (output && !output.toLowerCase().includes("nothing to save")) {
    ctx.ui.notify("🔧 Correction detected — memory updated", "info");
  }
}
```
Thread `memoryToolDef` + injectable `spawn` through `setupCorrectionDetector`'s deps.

- [ ] **Step 3: session-flush — swap the call**

In `src/handlers/session-flush.ts`, replace the `execChildPrompt` import with `spawnSubagent`. At ~L46:
```ts
try {
  await spawn({
    task: flushMessage,
    tier: "small",
    instructions: "Use ONLY the memory tool to save memories before context is lost. Do not read or modify files.",
    tools: ["memory"],
    extensionTools: [memoryToolDef],
    timeoutMs,
    retryOnTransient: false, // shutdown path — do not retry
  });
} catch {
  // Best-effort flush — never block shutdown
}
```
Thread `memoryToolDef` + injectable `spawn` through `setupSessionFlush`'s deps.

- [ ] **Step 4: Update `src/index.ts` wiring**

Pass `memoryToolDef` (captured in Task 1) into `setupBackgroundReview`, `setupCorrectionDetector`, `setupSessionFlush` (their `deps`/signature). Confirm no remaining `execChildPrompt` reference in these three files.

- [ ] **Step 5: Update the three test files**

Replace `execChild`/`execChildPrompt` injection in `tests/handlers/{background-review,correction-detector,session-flush}.test.ts` with a `spawn` mock returning `{ exitCode: 0, output: "...", stderr: "", timedOut: false }`. Assert `tools: ["memory"]` + `extensionTools` bridging + `tier: "small"`.

- [ ] **Step 6: Run tests + typecheck**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/ && bunx tsc --noEmit )`
Expected: PASS; no new tsc errors.

- [ ] **Step 7: Commit**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/background-review.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/handlers/correction-detector.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/handlers/session-flush.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/
git commit -m "refactor(hermes-memory): review-fallback + correction-detector + session-flush via spawnSubagent"
```

---

## Task 4: Delete `pi-child-process.ts` + narrow `ReviewTransport`

**Files:**
- Delete: `src/handlers/pi-child-process.ts`
- Modify: `src/types.ts` (`ReviewTransport`), `src/config.ts` (`REVIEW_TRANSPORTS`, `isReviewTransport`)
- Delete: `tests/handlers/pi-child-process.test.ts` (if present)

**Interfaces:**
- Consumes: all `execChildPrompt` callers are gone (Tasks 2–3).
- Produces: zero references to `execChildPrompt`/`pi-child-process` anywhere; `ReviewTransport = "direct"`.

- [ ] **Step 1: Confirm zero callers**

Run: `grep -rnE "execChildPrompt|pi-child-process|runSubprocessReview|buildSubprocessReviewPrompt|resolveChildPiInvocation" bun-apps/pi-agent-ext-hermes-memory/src`
Expected: **empty** (only the deletion target file itself, if any stale self-reference). If non-empty outside `pi-child-process.ts`, fix before deleting.

- [ ] **Step 2: Delete the file + its test**
```bash
git rm bun-apps/pi-agent-ext-hermes-memory/src/handlers/pi-child-process.ts
git rm -f bun-apps/pi-agent-ext-hermes-memory/tests/handlers/pi-child-process.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Narrow `ReviewTransport`**

In `src/types.ts` L13:
```ts
export type ReviewTransport = "direct";
```
In `src/config.ts` L23 + L26-27: `const REVIEW_TRANSPORTS: readonly ReviewTransport[] = ["direct"];` and `isReviewTransport` stays (now only accepts `"direct"`). Any external config value `"subprocess"` is rejected by `isReviewTransport` → falls through to the default `"direct"` (L57). Add a one-line comment at L23: `// "subprocess" removed in the spawnSubagent migration — the fallback is now spawnSubagent, not a pi -p subprocess.`

- [ ] **Step 4: Run full suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )`
Expected: all PASS; zero references to the deleted module.

- [ ] **Step 5: Commit**
```bash
git add -A bun-apps/pi-agent-ext-hermes-memory
git commit -m "refactor(hermes-memory): delete pi-child-process.ts + narrow ReviewTransport (spawnSubagent migration)"
```

---

## Task 5: Full verification + docs

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` (or README) — note the migration.
- Verify: cross-package (subagent + workflow still green).

- [ ] **Step 1: Cross-package verify**

Run:
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
( cd bun-apps/pi-agent-ext-subagent && bun test )
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )
```
Expected: all three green (the shared singleton via `src/` subpath must not regress workflow's `/subagents` viewer).

- [ ] **Step 2: Doc note**

In `CONTEXT.md` (or README), add a short Architecture note: "Consolidation, background-review fallback, correction-detector, and session-flush now dispatch via `spawnSubagent` (`@repo/pi-agent-ext-subagent`, small tier) instead of a bespoke `pi -p` subprocess. The child receives the `memory` tool via `extensionTools` bridging. `pi-child-process.ts` is deleted; `direct` (`completeSimple`) remains background-review's default transport."

- [ ] **Step 3: Acceptance grep**

Run: `grep -rnE "execChildPrompt|pi-child-process" bun-apps/pi-agent-ext-hermes-memory/src`
Expected: **empty**. And `grep -rn "spawnSubagent" bun-apps/pi-agent-ext-hermes-memory/src` shows the 4 migrated call sites.

- [ ] **Step 4: Commit**
```bash
git add bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md
git commit -m "docs(hermes-memory): note spawnSubagent child-execution migration"
```

## Verification (acceptance)
- `bun test` green across hermes-memory + subagent + workflow.
- `grep -rn execChildPrompt src/` → empty; `pi-child-process.ts` gone.
- Consolidation/review-fallback/correction/flush dispatch via `spawnSubagent` (tier small, `tools: ["memory"]`, `extensionTools` bridged).
- Migrated runs visible in `/subagents` viewer (src/ subpath import).
- Writes stay backend-neutral (via `MemoryStore`/`MemoryRepository`).
