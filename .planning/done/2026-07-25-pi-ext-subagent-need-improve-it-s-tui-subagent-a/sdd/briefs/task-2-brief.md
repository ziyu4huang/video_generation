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

