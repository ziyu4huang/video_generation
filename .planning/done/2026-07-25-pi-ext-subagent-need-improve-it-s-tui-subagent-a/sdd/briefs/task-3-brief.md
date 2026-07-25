### Task 3: Wire onModelResolved + renderCall to the registry

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (the tool-def `renderCall` ~line 606, and `execute`'s `onModelResolved` ~line 513)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`

**Interfaces:**
- Consumes (from Task 1): `registry.get(id)?.resolvedModel`, `registry.bindInvalidate(id, fn)`, `registry.updateModel(id, model)`.
- Consumes (from Task 2): `renderSubagentCall({ ...args, resolvedModel }, theme)`.
- Produces: the live call line updates with the concrete model id once the child resolves it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-tool.test.ts`. Add the `Text` import at the top if not already present:

```ts
import { Text } from "@earendil-works/pi-tui";
```

```ts
test("execute threads onModelResolved into registry.updateModel (live resolved model)", async () => {
  const reg = new SubagentInFlightRegistry();
  const updates: Array<[string, string]> = [];
  const orig = reg.updateModel.bind(reg);
  reg.updateModel = (id, model) => { updates.push([id, model]); orig(id, model); };
  const { spawn } = fakeSpawn(async (opts) => {
    opts.onModelResolved?.("google/gemma-4-12b-qat");
    return { exitCode: 0, output: "ok", stderr: "", timedOut: false, history: [] };
  });
  const tool = createSubagentTool({ spawn, inFlight: reg });
  await tool.execute("tc1", { task: "audit", tier: "medium" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(updates, [["tc1", "google/gemma-4-12b-qat"]]);
});

test("renderCall reads resolvedModel from the registry and binds invalidate", () => {
  const reg = new SubagentInFlightRegistry();
  const tool = createSubagentTool({ inFlight: reg });
  reg.start({ id: "tc9", model: "tier:medium", taskPreview: "x", startedAt: 0 });
  reg.updateModel("tc9", "google/gemma-4-12b-qat");
  let invalidated = 0;
  const text = new Text("", 0, 0);
  tool.renderCall!(
    { agent: "auditor", tier: "medium", task: "x" },
    T,
    { toolCallId: "tc9", lastComponent: text, invalidate: () => { invalidated++; } } as never,
  );
  assert.match(text.getText(), /tier:medium ▸ google\/gemma-4-12b-qat ▸/);
  // invalidate was bound — a later updateModel re-renders the call line
  reg.updateModel("tc9", "anthropic/claude-opus");
  assert.equal(invalidated, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "threads onModelResolved" )` then the renderCall one.
Expected: FAIL — `updates` is empty (onModelResolved doesn't call updateModel); renderCall ignores the registry (no model segment; invalidate not bound).

- [ ] **Step 3: Wire onModelResolved → updateModel**

In `src/subagent-tool.ts`, inside `execute`, update the `onModelResolved` callback (~line 513):

```ts
          onModelResolved: (id) => {
            resolvedModel = id;
            options.inFlight?.updateModel(toolCallId, id);
          },
```

- [ ] **Step 4: Wire renderCall to read + bind the registry**

In the same file, replace the tool-def `renderCall` (~line 606):

```ts
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      // The concrete model is only known mid-run (onModelResolved). Read the
      // latest from the registry (keyed by toolCallId) so the call line updates
      // live, and bind invalidate so updateModel can force a redraw even before
      // the next partial/history tick.
      const resolvedModel = options.inFlight?.get(context.toolCallId)?.resolvedModel;
      options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
      text.setText(renderSubagentCall({ ...args, resolvedModel }, theme));
      return text;
    },
```

- [ ] **Step 5: Run the full package test suite**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test )`
Expected: PASS — all tests, including the 2 new wiring tests. No regressions in `subagent-tool.test.ts`, `subagent-in-flight.test.ts`, `singleton.test.ts`, `regression-subagent-contract.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts
git commit -m "feat(subagent): wire resolved model into the live call line"
```

---

## Manual verification (after Task 3)

1. From repo root, start the GUI: `( cd bun-apps/gui-movie-director && bun run dev )` (discover port via `bun run --cwd bun-apps/gui-movie-director gui:port`).
2. Dispatch a `subagent` call without an explicit model, e.g. `subagent({ task: "read README.md", tier: "medium" })`.
3. Watch the call line: it should start as `subagent ▸ {agent} ▸ tier:medium ▸ "…"` and, once the child resolves its model, update to `subagent ▸ {agent} ▸ tier:medium ▸ {provider/model} ▸ "…"`.
4. Confirm the result line (`renderSubagentResult`) still shows `d.model` after completion — unchanged.

## Self-Review

- **Spec coverage:** WHERE (call line) → Task 2+3; FORMAT (tier ▸ full model ▸ task) → Task 2; pre-resolution behavior → Task 2 (omits when undefined); feasibility → verified pre-plan, exercised by Task 3 wiring tests + manual check. ✓
- **Placeholder scan:** none — every code step shows full code; every command is exact. ✓
- **Type consistency:** `resolvedModel?: string` used identically in `InFlightSubagent` (Task 1), `renderSubagentCall` arg (Task 2), and the renderCall spread (Task 3). `get`/`bindInvalidate`/`updateModel` signatures match across producer (Task 1) and consumers (Task 3). ✓
