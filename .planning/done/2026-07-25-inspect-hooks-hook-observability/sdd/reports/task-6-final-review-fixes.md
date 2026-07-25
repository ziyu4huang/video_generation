# Task 6 — Final Review Fixes Report

## Summary
Applied 4 mechanical fixes to the `inspect_hooks` feature in `bun-apps/pi-agent-ext-power-tool` as identified in final-review polish.

## Fixes Applied

### Fix 1 — byEvent text view shows extension names
**File**: `src/tools/inspect-hooks.ts`
**Change**: Modified the `byEvent` branch in `formatHooksReport` to output extension names on a second line after the count line.

**Before**:
```ts
lines.push(`  ${event.padEnd(28)} ${e.exts.length} ext(s)  ${e.handlers} handler(s)${flag}`);
```

**After**:
```ts
lines.push(`  ${event.padEnd(28)} ${e.exts.length} ext(s)  ${e.handlers} handler(s)${flag}`);
lines.push(`  ${"".padEnd(30)}${e.exts.join(", ")}`);
```

**Rationale**: The `by_event` flag's stated purpose is "who listens on event X?" — the extension list was being collected but discarded. Showing it on an indented second line keeps lines readable when many extensions register the same event.

---

### Fix 2 — byEvent test proves the branch ran
**File**: `src/tools/__tests__/inspect-hooks.test.ts`
**Change**: Added branch-specific assertions to the `byEvent=true` test.

**Before**:
```ts
test("byEvent=true groups the inventory by event", () => {
  const out = formatHooksReport(snapshot, analyzeHooks(snapshot), true);
  expect(out).toContain("turn_end");
});
```

**After**:
```ts
test("byEvent=true groups the inventory by event (and lists which extensions)", () => {
  const out = formatHooksReport(snapshot, analyzeHooks(snapshot), true);
  expect(out).toContain("Hooks by event:");
  expect(out).toContain("turn_end");
  expect(out).toContain("ext-a/a.ts"); // the who-list (Fix 1)
});
```

**Rationale**: The original test only asserted `toContain("turn_end")`, which the non-byEvent path also produces. Added `Hooks by event:` (branch-specific heading) and `ext-a/a.ts` (the who-list from Fix 1) to prove the `byEvent` branch actually ran.

---

### Fix 3 — sdk-patch test invokes the polyfills
**File**: `src/__tests__/sdk-patch.test.ts`
**Change**: Made the "unchanged behavior" test actually invoke the polyfills and assert they call through to the runner functions.

**Before**:
```ts
test("installs getSystemPromptOptions + getSystemPrompt (unchanged behavior)", () => {
  const ctx: Record<string, unknown> = {};
  applyContextPolyfills(ctx, fakeRunner([]));
  expect(typeof ctx.getSystemPromptOptions).toBe("function");
  expect(typeof ctx.getSystemPrompt).toBe("function");
});
```

**After**:
```ts
test("installs getSystemPromptOptions + getSystemPrompt and they invoke the runner fns", () => {
  const marker = { __marker: true } as never;
  const ctx: Record<string, unknown> = {};
  applyContextPolyfills(ctx, {
    assertActive() {},
    getSystemPromptOptionsFn: () => marker,
    getSystemPromptFn: () => "SP",
    extensions: [],
  });
  expect((ctx.getSystemPromptOptions as () => unknown)()).toBe(marker);
  expect((ctx.getSystemPrompt as () => unknown)()).toBe("SP");
});
```

**Rationale**: The original test only checked `typeof === "function"`. The new test provides mock runner functions with known return values (`marker` object and `"SP"` string) and asserts the polyfills return those exact values, proving they call through correctly.

---

### Fix 4 — PRD heading house style
**File**: `PRD.md`
**Change**: Added backticks to the `inspect_hooks` subsection heading for consistency with README style.

**Before**:
```markdown
### inspect_hooks
```

**After**:
```markdown
### `inspect_hooks`
```

**Rationale**: The README uses `### \`inspect_hooks\`` (with backticks). PRD should follow the same house style for inline code references.

---

## Test Results

### Targeted test files (Fixes 1-3)
```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts src/__tests__/sdk-patch.test.ts )
```

**Result**: 17 pass, 0 fail

### Full test suite (all fixes)
```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```

**Result**: 136 pass, 4 skip, 0 fail

All tests remain green. The full suite pass count matches expectations.

---

## Commit

**SHA**: `97a1353c`
**Subject**: `fix(power-tool): inspect_hooks byEvent shows extensions; strengthen sdk-patch/test assertions; PRD heading style`

**Files changed**:
- `src/tools/inspect-hooks.ts` (Fix 1)
- `src/tools/__tests__/inspect-hooks.test.ts` (Fix 2)
- `src/__tests__/sdk-patch.test.ts` (Fix 3)
- `PRD.md` (Fix 4)

**Stats**: 4 files changed, 15 insertions(+), 6 deletions(-)
