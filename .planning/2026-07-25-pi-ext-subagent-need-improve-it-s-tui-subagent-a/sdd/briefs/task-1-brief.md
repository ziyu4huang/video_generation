### Task 1: Registry — hold + invalidate on resolved model

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts`
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts`

**Interfaces:**
- Produces: `InFlightSubagent.resolvedModel?: string`, `InFlightSubagent.invalidate?: () => void`; `SubagentInFlightRegistry.get(id)`, `.bindInvalidate(id, fn)`, `.updateModel(id, model)`. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-in-flight.test.ts`:

```ts
test("get returns the live entry by id", () => {
  const reg = new SubagentInFlightRegistry();
  assert.equal(reg.get("missing"), undefined);
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  assert.equal(reg.get("a")?.model, "x");
});

test("updateModel records resolvedModel and triggers the bound invalidate", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => { invalidated++; });
  reg.updateModel("a", "google/gemma-4-12b-qat");
  assert.equal(reg.get("a")?.resolvedModel, "google/gemma-4-12b-qat");
  assert.equal(invalidated, 1);
});

test("updateModel on an unknown or ended id is a no-op", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.updateModel("ghost", "x/y"); // unknown id — no throw, no invalidate
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => { invalidated++; });
  reg.end("a");
  reg.updateModel("a", "x/y"); // ended — no-op
  assert.equal(reg.get("a"), undefined);
  assert.equal(invalidated, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: FAIL — `get` / `bindInvalidate` / `updateModel` are not functions; `resolvedModel` is undefined.

- [ ] **Step 3: Implement the registry changes**

In `src/subagent-in-flight.ts`, extend the interface and class:

```ts
export interface InFlightSubagent {
  /** The toolCallId (unique per dispatch). */
  id: string;
  agent?: string;
  model: string;
  /** Concrete provider/id once the child resolves its model (onModelResolved).
   * Undefined until resolution — the call line shows tier/model-request until then. */
  resolvedModel?: string;
  taskPreview: string;
  startedAt: number;
  /** Latest compact history snapshot (for the live-output trace). */
  history?: AgentHistoryEntry[];
  /** Bound by renderCall so updateModel can force a call-line re-render mid-run. */
  invalidate?: () => void;
}
```

Add three methods inside `SubagentInFlightRegistry` (after `update`, before `end`):

```ts
  get(id: string): InFlightSubagent | undefined {
    return this.runs.get(id);
  }

  /** Bind the harness invalidate for this run (called from the tool's renderCall). */
  bindInvalidate(id: string, invalidate: () => void): void {
    const r = this.runs.get(id);
    if (r) r.invalidate = invalidate;
  }

  /** Record the concrete resolved model and force a call-line re-render when an
   * invalidate was bound. No-op after end() (run gone) — mirrors update(). */
  updateModel(id: string, model: string): void {
    const r = this.runs.get(id);
    if (!r) return;
    r.resolvedModel = model;
    r.invalidate?.();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )`
Expected: PASS — all 5 tests (2 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts
git commit -m "feat(subagent): registry holds resolvedModel + drives call-line invalidate"
```

---

