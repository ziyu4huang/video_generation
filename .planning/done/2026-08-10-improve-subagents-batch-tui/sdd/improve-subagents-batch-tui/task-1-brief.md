### Task 1: Expose `onUsage` on `SpawnSubagentOptions` and forward it

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts` (interface ~line 116 area; `tryOnce` `onUsage` closure ~line 251)
- Test: `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts`

**Interfaces:**
- Consumes: `AgentUsage` (already imported in `spawn-subagent.ts`); the existing `mkRunner` injectable-runner pattern in `spawn-subagent.test.ts`.
- Produces: `SpawnSubagentOptions.onUsage?: (u: AgentUsage) => void` — a new optional callback. Task 6 wires it on `childSpawnOpts` to populate the batch's `runningUsage` map.

- [ ] **Step 1: Write the failing test**

Append to `tests/spawn-subagent.test.ts` (inside the existing top-level `describe("spawnSubagent", …)` block, after the `"forwards tier/onModelResolved/onModelFallback to runner.run"` test):

```ts
it("forwards onUsage to the caller (fires once at run end) alongside the internal result.usage capture", async () => {
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.012 };
  const runner = mkRunner(async ({ opts }) => {
    opts.onUsage?.(usage);
    return "ok";
  });
  const seen: AgentUsage[] = [];
  const res = await spawnSubagent({ task: "t", agent: runner, onUsage: (u) => seen.push(u) });
  assert.equal(seen.length, 1, "opts.onUsage fires exactly once");
  assert.deepEqual(seen[0], usage, "the caller receives the usage payload verbatim");
  assert.deepEqual(res.usage, usage, "the internal result.usage capture still works (not removed)");
});

it("onUsage is optional — omitting it changes nothing (result.usage still captured)", async () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 5, cost: 0.001 };
  const runner = mkRunner(async ({ opts }) => {
    opts.onUsage?.(usage);
    return "ok";
  });
  const res = await spawnSubagent({ task: "t", agent: runner });
  assert.deepEqual(res.usage, usage, "result.usage captured even with no caller onUsage");
});
```

Add `AgentUsage` to the test file's imports from `@repo/pi-agent-ext-core-runtime`:

```ts
import { saveModelTierConfig, WorkflowError, WorkflowErrorCode, type AgentUsage } from "@repo/pi-agent-ext-core-runtime";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent.test.ts )`
Expected: FAIL — `onUsage` does not exist on `SpawnSubagentOptions` (TS type error / `undefined is not a function` at `opts.onUsage` passed by the test never reaches the caller).

- [ ] **Step 3: Write minimal implementation**

In `spawn-subagent.ts`, add the field to `SpawnSubagentOptions` (place it right after the existing `onHistory?` field, keeping the callback-field grouping):

```ts
  /**
   * Fires with the child's real token/cost usage once known. Emitted exactly
   * once, at run completion (the runner reads session stats in its `finally`).
   * Mirrors {@link onHistory} / {@link onModelResolved} / {@link onModelFallback}
   * — additive + optional. The internal `result.usage` capture is unchanged, so
   * both this live callback and the final result carry usage.
   */
  onUsage?: (u: AgentUsage) => void;
```

Then, in `tryOnce`, update the existing internal `onUsage` closure (currently `onUsage: (u) => { usage = u; }`) to ALSO forward to the caller — keep the local capture:

```ts
        onUsage: (u) => {
          usage = u;
          opts.onUsage?.(u);
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent.test.ts )`
Expected: PASS — both new tests green; `result.usage` capture intact.

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`
Expected: biome clean, tsc clean.

```bash
git add bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts
git commit -m "feat(subagent): expose additive onUsage callback on SpawnSubagentOptions

Forwarded to runner.run() alongside the existing internal result.usage
capture (both work). Additive + optional, mirrors onHistory/onModelResolved.
Feeds the batch subagents tool's running-header usage aggregate."
```

---

