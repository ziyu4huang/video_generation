# Subagent call-line: show resolved model id mid-run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a `subagent` tool call is running, show the concrete resolved model id (e.g. `google/gemma-4-12b-qat`) on the call line as a separate segment after the tier, so the user sees both what they requested (`tier:medium`) and what actually ran.

**Architecture:** The child's concrete model is captured mid-run by the existing `onModelResolved` callback (fired by `WorkflowAgent` once it resolves its model). Thread it through the `SubagentInFlightRegistry` keyed by `toolCallId`: `onModelResolved` writes it via a new `updateModel()`; the tool's `renderCall` (which receives `context.toolCallId`) reads it back and renders it through `renderSubagentCall`. Re-rendering is free — pi's tool-execution layer re-invokes `renderCall` on every `context.invalidate()` and on every partial `updateResult`, so no harness change. To make the live update robust even before the first history/partial tick, `renderCall` binds `context.invalidate` into the registry, and `updateModel` calls it.

**Tech Stack:** TypeScript, Bun test (`bun:test` + `node:assert`), `@earendil-works/pi-tui` (`Text` component), TypeBox params.

## Global Constraints

- Package root: `bun-apps/pi-agent-ext-subagent/`. Run tests with `( cd bun-apps/pi-agent-ext-subagent && bun test )` (tests import from `../src/`, so run from the package dir).
- Shell discipline: never top-level `cd` — wrap in `( cd <dir> && ... )`.
- Written artifacts (code, comments, commit messages) in English; conversation in zh-TW.
- Out of scope: the `workflow` extension's agent rows (separate render path). Subagent tool only.
- The call line's requested-model slot stays unchanged: explicit `model` → that id; else `tier:<tier>`; else `default`. The resolved model is an *additional* segment, never a replacement.

## Resolved decisions (from wayfinder grilling)

1. **WHERE:** the call line itself (`renderSubagentCall`), not the progress header.
2. **FORMAT:** `subagent ▸ {agent} ▸ tier:medium ▸ google/gemma-4-12b-qat ▸ "{task}"` — tier preserved, full `provider/id` as its own `▸` segment.
3. **Pre-resolution:** shows current `tier:medium` only; the model segment appears once `onModelResolved` fires.
4. **Feasibility (verified):** `context.invalidate()` + `updateDisplay()` in pi's `tool-execution.js` re-invoke `renderCall` on every render — confirmed by reading the harness source. No fork.

## File Structure

- `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` — add `resolvedModel` + `invalidate` to `InFlightSubagent`; add `get()`, `bindInvalidate()`, `updateModel()` to the registry.
- `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` — `renderSubagentCall` gains an optional `resolvedModel` segment; the tool-def `renderCall` reads the registry + binds invalidate; `execute`'s `onModelResolved` calls `updateModel`.
- `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts` — registry lifecycle tests for the new methods.
- `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` — `renderSubagentCall` segment tests + execute/renderCall wiring tests.

---

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

### Task 2: renderSubagentCall — the resolved-model segment

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (the `renderSubagentCall` helper, ~line 281)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`

**Interfaces:**
- Produces: `renderSubagentCall(args, theme)` now accepts `args.resolvedModel?: string` and appends `▸ {resolvedModel}` when set and distinct from the requested-model slot. Consumed by Task 3's renderCall wiring.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagent-tool.test.ts`, next to the existing `renderSubagentCall` tests (after the `tier:small` test):

```ts
test("renderSubagentCall appends resolved model as a separate segment when tier is shown", () => {
  const out = renderSubagentCall(
    { agent: "auditor", tier: "medium", task: "x", resolvedModel: "google/gemma-4-12b-qat" },
    T,
  );
  assert.match(out, /tier:medium ▸ google\/gemma-4-12b-qat ▸/);
});

test("renderSubagentCall omits resolved model before resolution (undefined)", () => {
  const out = renderSubagentCall({ agent: "auditor", tier: "medium", task: "x" }, T);
  assert.match(out, /tier:medium/);
  assert.doesNotMatch(out, /google/);
});

test("renderSubagentCall omits resolved model when it equals the explicit model slot (no dup)", () => {
  const out = renderSubagentCall(
    { agent: "scout", model: "x/flash", task: "x", resolvedModel: "x/flash" },
    T,
  );
  assert.equal((out.match(/x\/flash/g) || []).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `resolvedModel` is ignored (segment never appears / dup not skipped). The existing `tier:small` and `default` tests still pass.

- [ ] **Step 3: Update renderSubagentCall**

In `src/subagent-tool.ts`, replace the `renderSubagentCall` helper:

```ts
/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: { agent?: string; model?: string; tier?: string; task: string; resolvedModel?: string },
  theme: Theme,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  // Requested-model slot: explicit model, else tier, else "default".
  const slot = args.model ?? (args.tier ? `tier:${args.tier}` : "default");
  parts.push(theme.fg("muted", slot));
  // Concrete model resolved mid-run (onModelResolved). Separate segment so the
  // requested tier/model stays visible. Skipped when it matches the slot (e.g.
  // an explicit model that resolved to itself) to avoid duplication.
  if (args.resolvedModel && args.resolvedModel !== slot) {
    parts.push(theme.fg("muted", args.resolvedModel));
  }
  parts.push(theme.fg("dim", `"${taskPreview(args.task, 60)}"`));
  return parts.join(" ▸ ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )`
Expected: PASS — the 3 new tests + all existing renderSubagentCall tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts
git commit -m "feat(subagent): renderSubagentCall shows resolved model as a segment"
```

---

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
