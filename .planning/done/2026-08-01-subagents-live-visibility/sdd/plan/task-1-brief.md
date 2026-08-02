### Task 1: Batch tool forwards live callbacks + sets `batchId`

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` (`InFlightSubagent` type)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (the per-child loop in `execute()`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `SpawnSubagentOptions.onModelResolved` / `onHistory` (already exist on `spawnSubagent`), `SubagentInFlightRegistry.updateModel(id, model)` / `update(id, history)`.
- Produces: `InFlightSubagent.batchId?: string` — consumed by Task 2's viewer grouping.

- [ ] **Step 1: Write the failing test (in-flight carries `batchId`)**

Append to `tests/subagent-in-flight.test.ts`:

```ts
test("start carries batchId through for batch-tool children; undefined for singular-tool runs", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "batch-1" });
  assert.equal(reg.get("c0")?.batchId, "batch-1");
  // singular-tool children omit it → undefined (backward compatible)
  reg.start({ id: "solo", model: "y", taskPreview: "u", startedAt: 0 });
  assert.equal(reg.get("solo")?.batchId, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: FAIL — TypeScript error: `batchId` does not exist on the `InFlightSubagent` literal passed to `start()`.

- [ ] **Step 3: Add `batchId` to the type**

In `src/subagent-in-flight.ts`, add the optional field to `InFlightSubagent` (after `resolvedModel`):

```ts
export interface InFlightSubagent {
  id: string;
  agent?: string;
  model: string;
  resolvedModel?: string;
  /** The batch tool's own toolCallId, set on every child of a `subagents` batch so
   *  the /subagents viewer can group them under one header. Undefined for singular
   *  `subagent` dispatches (flat, ungrouped) and workflow agents. */
  batchId?: string;
  taskPreview: string;
  startedAt: number;
  history?: AgentHistoryEntry[];
  invalidate?: () => void;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: PASS.

- [ ] **Step 5: Write the failing test (batch tool sets `batchId` + forwards callbacks)**

Append to `tests/subagents-tool.test.ts`. The fake spawn reads the callback opts and captures the registry mid-run:

```ts
test("batch children get batchId + forwarded onModelResolved/onHistory update the registry", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const captured: { id: string; batchId?: string; resolved?: string; historyLen: number }[] = [];
  const spawn = async (opts: {
    task: string;
    onModelResolved?: (id: string) => void;
    onHistory?: (h: { kind: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onModelResolved?.("google/gemma-4-12b-qat");
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    const entry = inFlight.get(`batch-call:${idx}`);
    captured.push({
      id: `batch-call:${idx}`,
      batchId: entry?.batchId,
      resolved: entry?.resolvedModel,
      historyLen: entry?.history?.length ?? 0,
    });
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-call",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(captured.length, 2, "both children ran");
  for (const c of captured) {
    assert.equal(c.batchId, "batch-call", "child registered with the batch toolCallId as batchId");
    assert.equal(c.resolved, "google/gemma-4-12b-qat", "onModelResolved forwarded → resolvedModel set");
    assert.equal(c.historyLen, 1, "onHistory forwarded → history stored");
  }
  assert.equal(inFlight.list().length, 0, "registry empty after the batch completes");
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts -t "batch children get batchId" )`
Expected: FAIL — `batchId` undefined, `resolved` undefined, `historyLen` 0 (callbacks not forwarded).

- [ ] **Step 7: Forward callbacks + set `batchId` at the spawn call site**

In `src/subagents-tool.ts`, inside `execute()`'s `runWithConcurrency` callback, locate the block that builds `childOpts` and calls `spawn`. Two edits:

(a) Add `batchId` to the `inFlight.start` call:

```ts
options.inFlight?.start({
  id: childRunId,
  model: childModel,
  taskPreview: taskPreview(task.task),
  startedAt: childT0,
  batchId: toolCallId,
});
```

(b) Build the spawn opts with the callbacks spread in (they need `inFlight` + `childRunId`, which `mergeReadOnlyExclusion` does not have):

```ts
const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
// Forward live callbacks so /subagents shows each child's resolved model and
// activity trace (deficit 1). Added here — not in mergeReadOnlyExclusion — because
// the callbacks close over the registry + childRunId, which that pure helper lacks.
const childSpawnOpts: SpawnSubagentOptions = {
  ...childOpts,
  onModelResolved: (id) => options.inFlight?.updateModel(childRunId, id),
  onHistory: (history) => options.inFlight?.update(childRunId, history),
};
let result: SpawnSubagentResult;
try {
  result = await spawn(childSpawnOpts);
} finally {
  options.inFlight?.end(childRunId);
}
```

`AgentHistoryEntry` is the `onHistory` parameter type — it is already imported in `subagents-tool.ts`? Check: if not, the inferred type from `SpawnSubagentOptions.onHistory` makes the annotation unnecessary; drop the explicit param type and let it infer: `onHistory: (history) => options.inFlight?.update(childRunId, history)`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS (new test + all existing batch-tool tests).

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts \
        bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts \
        bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): forward per-child live callbacks + set batchId on in-flight entries"
```

---

