# Improve `subagents` batch TUI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the batch `subagents` tool card render the same per-child meta the single `subagent` card renders (`model · elapsed · $cost · Ntok`, fallback-aware) across all three render states: running-live, done-collapsed, done-expanded — plus an aggregate Σtok/$Σ in both the running and done headers.

**Architecture:** A render-choice gap, not a data gap. `BatchResultSlot` already carries `model`/`requestedModel`/`fellBack`/`elapsedMs`/`usage`. We add four pure string helpers (`formatUsage`, `formatModelSeg`, `formatSlotMeta`, `sumUsage`) + one pure live-table builder (`buildLiveTable`), then rewrite `renderSubagentsResult` (done collapsed + expanded) and the `onHistory → onUpdate` live text to consume them. The only non-render change is exposing an additive `onUsage?` callback on `SpawnSubagentOptions` so the batch can keep a local `runningUsage: Map<runId, AgentUsage>` for the running header's Σ.

**Tech Stack:** Bun + TypeScript (agent/GUI code — NOT MLX/Python). Tests via `bun test` (assertions from `node:assert/strict`). Package gates: `biome check .` (`bun run check`) + `tsc --noEmit`/`bunx tsc` (`bun run build`).

## Global Constraints

- **Scope ceiling:** all render changes land in `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`. The ONLY other touched file is `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts` (additive `onUsage` option). No changes to `@repo/pi-agent-ext-core-runtime` types (notably `InFlightSubagent`/`AgentUsage` are used as-is).
- **Read-only enforcement stays intact:** `edit`/`write`/`bash` are always excluded on batch children — do not touch `READ_ONLY_EXCLUDED` / `mergeReadOnlyExclusion`.
- **Defensive render builders:** every new helper must degrade on missing fields (return `""` / skip), never throw. `onUpdate` stays wrapped in its existing `try { … } catch { /* swallowed */ }` (diagnostic only — a throwing `onUpdate` must never change the batch result or fail a child).
- **Keep existing tests green** EXCEPT the one `onUpdate` single-line assertion test (`"onUpdate emits a single-line 'k/N running · latest'…"`) whose contract intentionally changes in Task 6 — it is updated in-task. There are NO snapshot test files in `tests/` (all assertion-based), so "update snapshots" = update that one assertion test + add new tests.
- **Test runner:** `( cd bun-apps/pi-agent-ext-subagent && bun test )` for the tight TDD loop. Run `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )` (biome + tsc) before each commit so the package's canonical `bun run test` stays green.
- **Type imports:** `AgentUsage` comes from `@repo/pi-agent-ext-core-runtime` (already imported in both files). `InFlightSubagent` is the registry entry type (already imported transitively via `SubagentInFlightRegistry`).

### Plan-time decisions (resolved against code — encode, don't re-decide)

1. **EXPOSE `onUsage` now (full vision).** Add `onUsage?: (u: AgentUsage) => void` to `SpawnSubagentOptions` — additive, optional, non-breaking; it mirrors the existing `onHistory` / `onModelResolved` / `onModelFallback` callback fields on that same interface. Forward it through `spawnSubagent()` → `runner.run()` ALONGSIDE the existing internal closure capture (`let usage`), so BOTH the live callback AND the final `result.usage` keep working. The spec labeled this "the only non-render change" — correct in spirit, but it is a shared public-options-type change; it is idiomatic and additive (no caller breaks).

2. **`onUsage` fires ONCE per child, at run completion.** `runner.run()` emits `onUsage` exactly once, in its `finally` block, reading `session.getSessionStats()` right before `dispose()` (see `bun-apps/pi-agent-ext-core-runtime/src/agent.ts:687-701`). It is NOT a per-token stream. Consequence: the **Running header's Σtok/$Σ = sum over children completed-so-far**, updated when each child's `onUsage` fires (and reflected on the next sibling `onHistory` tick). This is the honest, available data; it is NOT a live per-token ticker (that data does not exist in the runtime).

3. **Live row omits the `(id)` caller tag.** `InFlightSubagent` has no caller-tag field (only the runId `id`, `model`, `resolvedModel`, `requestedModel`, `fellBack`, `status`, `startedAt`, `history`, `taskPreview`). Threading `BatchTask.id` into the registry entry would require a `@repo/pi-agent-ext-core-runtime` type change, which is out of scope. So the live row renders `[i] slot ⏱/✓ liveElapsed · currentAction` (dispatch index `[i]` + model + glyph + elapsed + action); the caller `(id)` tag appears in the DONE rows via `slot.id` (which DOES carry it). Surfaced explicitly rather than guessed.

4. **`buildLiveTable` signature is `(entries, now)`, not `(entries, theme)`.** `execute()` does not receive a `Theme` (the `defineTool` execute signature has no theme param). The live text is emitted as PLAIN text and themed-as-dim by `renderSubagentsResult`'s existing `isPartial` branch (`theme.fg("dim", …)`). So `buildLiveTable` takes an injectable `now: number` (for deterministic elapsed in tests) instead of a theme. `formatModelSeg` (theme-free) is shared between the live table (plain) and `formatSlotMeta` (themed).

5. **Done-collapsed keeps the fixed-width status badge.** The spec table writes the badge as `✓` (shorthand). We PRESERVE the existing fixed-width padded badge from ticket 05 / finding 6 (`batchStatusBadge` → `✓ done` / `⏱ timedout` / `⛔ budget` / `⊘ aborted` / `✗ failed`, padded to `BATCH_BADGE_WIDTH`) so the `model · elapsed · …` columns stay aligned across rows. The collapsed task-preview is quoted (`"task"`) per the spec table.

6. **Header Σ order follows the spec table literally:** Running header = `… · Σtok · $Σ` (tokens first); Done header = `… — Ts · $Σ · Σtok` (cost first, matching the single card's `$cost · Ntok`). Both use `cost.toFixed(3)` + integer `total` to match the single card.

---

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

### Task 2: Pure render helpers — `formatUsage`, `formatModelSeg`, `formatSlotMeta`, `sumUsage`

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (add four exported pure fns near `batchStatusBadge`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `AgentUsage` (imported), `shortModel` (imported from `@repo/pi-agent-ext-core-runtime`), `Theme` (imported from `@earendil-works/pi-coding-agent`).
- Produces:
  - `formatUsage(u: AgentUsage | undefined): string` → ` · $X.XXX · Ntok` when `u && u.total > 0`, else `""`. Byte-identical to the single card's `usageStr`.
  - `formatModelSeg(model: string, requestedModel?: string, fellBack?: boolean): string` → fallback-aware model label (`requested → actual`, both `shortModel`-ed), else `shortModel(model) ?? "default"`. Theme-free (shared by live table + themed meta).
  - `formatSlotMeta(slot: { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage }, theme: Theme): string` → themed `model · elapsed · usage` line (used by done collapsed + expanded).
  - `sumUsage(values: Iterable<AgentUsage>): { total: number; cost: number }` → `{total:0, cost:0}` for empty. Feeds both done-header and live-header Σ (Task 3 + Task 6).

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
import {
  // …existing imports from "../src/subagents-tool.js"…
  formatUsage,
  formatModelSeg,
  formatSlotMeta,
  sumUsage,
} from "../src/subagents-tool.js";
import type { AgentUsage } from "@repo/pi-agent-ext-core-runtime";

const U = (total: number, cost: number): AgentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost,
});

test("formatUsage: empty when no usage or zero total; else ` · $cost · Ntok` (3-decimal cost)", () => {
  assert.equal(formatUsage(undefined), "");
  assert.equal(formatUsage(U(0, 0)), "");
  assert.equal(formatUsage(U(15715, 0.0004)), " · $0.000 · 15715 tok");
  assert.equal(formatUsage(U(1000, 0.5)), " · $0.500 · 1000 tok");
});

test("formatModelSeg: shortens provider prefix; `requested → actual` on fallback; default fallback", () => {
  assert.equal(formatModelSeg("zai/glm-5.2"), "glm-5.2");
  assert.equal(formatModelSeg("tier:small"), "tier:small");
  assert.equal(formatModelSeg("anthropic/claude-opus-4-1", "anthropic/claude-opus-4-1", true), "claude-opus-4-1 → claude-opus-4-1");
  assert.equal(formatModelSeg("zai/glm-5.2", "anthropic/claude-opus-4-1", true), "claude-opus-4-1 → glm-5.2");
  assert.equal(formatModelSeg(""), "default");
});

test("formatSlotMeta: themed `model · elapsed · usage`; defensive on missing usage", () => {
  const meta = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500, usage: U(15715, 0.0004) }, THEME);
  assert.equal(meta, "glm-5.2 · 34.5s · $0.000 · 15715 tok");
  const noUsage = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500 }, THEME);
  assert.equal(noUsage, "glm-5.2 · 34.5s");
  const fb = formatSlotMeta(
    { model: "zai/glm-5.2", requestedModel: "anthropic/claude-opus-4-1", fellBack: true, elapsedMs: 1000, usage: U(10, 0.001) },
    THEME,
  );
  assert.equal(fb, "claude-opus-4-1 → glm-5.2 · 1.0s · $0.001 · 10 tok");
});

test("sumUsage: sums total+cost across an iterable; empty → zeros", () => {
  assert.deepEqual(sumUsage([]), { total: 0, cost: 0 });
  assert.deepEqual(sumUsage([U(100, 0.1), U(200, 0.2)]), { total: 300, cost: 0.30000000000000004 });
  assert.deepEqual(sumUsage(new Map([["a", U(50, 0.05)]]).values()), { total: 50, cost: 0.05 });
});
```

(`THEME` is the existing identity-theme const already defined at the top of the render-test section of `tests/subagents-tool.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `formatUsage`/`formatModelSeg`/`formatSlotMeta`/`sumUsage` are not exported (import error).

- [ ] **Step 3: Write minimal implementation**

In `subagents-tool.ts`, add these four pure helpers immediately after the `batchStatusBadge` function (before `renderSubagentsResult`):

```ts
/** Usage segment mirroring the single `subagent` card's meta: ` · $X.XXX · Ntok`
 *  when usage is present and non-zero, else `""` (defensive — degrades to empty). */
export function formatUsage(u: AgentUsage | undefined): string {
  return u && u.total > 0 ? ` · $${u.cost.toFixed(3)} · ${u.total} tok` : "";
}

/** Fallback-aware model label (theme-free so the live table and the themed meta
 *  share it). On fallback shows `requested → actual` (both shortModel-ed); else
 *  the resolved model shortModel-ed; `"default"` when empty. Mirrors the single
 *  card's `modelSeg`. */
export function formatModelSeg(model: string, requestedModel?: string, fellBack?: boolean): string {
  if (fellBack && requestedModel) {
    return `${shortModel(requestedModel) ?? "default"} → ${shortModel(model) ?? "default"}`;
  }
  return shortModel(model) ?? "default";
}

/** Themed `model · elapsed · usage` line for a done/timedout/aborted/budget slot.
 *  Shared by the done-collapsed per-slot line and the done-expanded meta line
 *  (DRY). `usage` optional → degrades to `model · elapsed`. */
export function formatSlotMeta(
  slot: { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
  theme: Theme,
): string {
  return theme.fg("muted", `${formatModelSeg(slot.model, slot.requestedModel, slot.fellBack)} · ${(slot.elapsedMs / 1000).toFixed(1)}s${formatUsage(slot.usage)}`);
}

/** Sum total + cost across any iterable of AgentUsage (slots' usage for the done
 *  header; the runningUsage map's values for the live header). Empty → zeros. */
export function sumUsage(values: Iterable<AgentUsage>): { total: number; cost: number } {
  let total = 0;
  let cost = 0;
  for (const v of values) {
    total += v.total;
    cost += v.cost;
  }
  return { total, cost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all four helper tests green; existing tests untouched.

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`
Expected: biome clean, tsc clean.

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "refactor(subagents): add pure render helpers formatUsage/formatModelSeg/formatSlotMeta/sumUsage

Shared by the done + live render rewrites (Tasks 3-6). formatSlotMeta +
formatModelSeg mirror the single subagent card's meta (fallback-aware).
sumUsage feeds both the done-header and live-header usage aggregates."
```

---

### Task 3: Done header Σ + done-collapsed per-slot meta

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`renderSubagentsResult` — header build + collapsed branch, ~line 660-720)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `formatSlotMeta`, `formatUsage`, `sumUsage` (Task 2); the existing `batchStatusBadge` + `BATCH_BADGE_WIDTH` (unchanged).
- Produces: `renderSubagentsResult` now (a) appends ` · $Σ · Σtok` to the done header when aggregate usage > 0, and (b) renders each collapsed per-slot line as `[i] (id) badge · <formatSlotMeta> · "task"` (meta replaces the inlined model+elapsed; quoted task preview).

**Render-target cell (done-collapsed):** `[i] (id) ✓ model · elapsed · $cost · Ntok · "task"` — `✓` = the fixed-width padded status badge (kept).

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
test("done header appends aggregate ` · $Σ · Σtok` when slots carry usage", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "a", status: "done", index: 0, task: "t0", model: "zai/glm-5.2", elapsedMs: 1000, usage: U(1000, 0.1) },
      { output: "b", status: "done", index: 1, task: "t1", model: "zai/glm-5.2", elapsedMs: 2000, usage: U(2000, 0.2) },
      null,
    ],
    dispatched: 2,
    skipped: 0,
    elapsedMs: 3000,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /— 3\.0s · \$0\.300 · 3000 tok/);
});

test("done header omits the aggregate suffix when no slot carries usage (byte-stable)", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "a", status: "done", index: 0, task: "t0", model: "zai/glm-5.2", elapsedMs: 1000 },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /— 1\.0s$/m); // no trailing ` · $… · … tok`
  assert.doesNotMatch(collapsed, /tok/);
});

test("done collapsed: per-slot line shows `badge · model · elapsed · $cost · Ntok · \"task\"` (with usage)", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "ok",
        status: "done",
        index: 0,
        id: "alpha",
        task: "audit the parser",
        model: "zai/glm-5.2",
        elapsedMs: 34500,
        usage: U(15715, 0.0004),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 34500,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /\(alpha\)/);
  assert.match(slot0, /✓ done/); // fixed-width badge kept
  assert.match(slot0, /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/);
  assert.match(slot0, /"audit the parser"/); // quoted task preview
  assert.ok(!slot0.includes("zai/glm-5.2"), "provider prefix dropped on the collapsed line");
});

test("done collapsed: fallback slot shows `requested → actual` in the meta segment", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "ok",
        status: "done",
        index: 0,
        task: "t",
        model: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
        elapsedMs: 1000,
        usage: U(10, 0.001),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 1000,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  assert.match(collapsed, /claude-opus-4-1 → glm-5\.2 · 1\.0s · \$0\.001 · 10 tok/);
});

test("done collapsed: per-slot meta degrades (no usage → `model · elapsed · \"task\"`)", () => {
  const details: SubagentsToolDetails = {
    results: [
      { output: "", status: "aborted", index: 0, id: "x", task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 500 },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 500,
  };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const slot0 = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(slot0, /⊘ aborted/);
  assert.match(slot0, /glm-5\.2 · 0\.5s · "t-aborted"/);
  assert.doesNotMatch(slot0, /tok/);
});

test("done collapsed: null (failed) slot still renders the terse failed line (no meta)", () => {
  const details: SubagentsToolDetails = { results: [null], dispatched: 0, skipped: 0, elapsedMs: 10 };
  const collapsed = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, THEME);
  const line = collapsed.split("\n").find((l) => l.includes("[0]")) ?? "";
  assert.match(line, /✗ failed/);
  assert.match(line, /child failed/);
  assert.doesNotMatch(line, /· .*s ·/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — header has no aggregate suffix; collapsed per-slot line still uses the old inlined `model  ·  elapsed  ·  task` (no cost/tokens, no quotes).

- [ ] **Step 3: Write minimal implementation**

In `renderSubagentsResult`, replace the header build and the collapsed branch. First, the header — after computing `done`/`aborted`/`failed`, compute the aggregate and append it:

```ts
  // Aggregate usage across non-null slots that carry usage → header Σtok/$Σ
  // (mirrors the single card's `$cost · Ntok`, appended after elapsed).
  const slotUsages: AgentUsage[] = [];
  for (const s of d.results) {
    if (s && (s as { usage?: AgentUsage }).usage) slotUsages.push((s as { usage: AgentUsage }).usage);
  }
  const agg = sumUsage(slotUsages);
  const aggStr = agg.total > 0 ? ` · $${agg.cost.toFixed(3)} · ${agg.total} tok` : "";
  const header =
    `subagents batch (${done} ok` +
    (aborted ? ` · ${aborted} aborted` : "") +
    ` · ${failed} failed` +
    ` · ${d.skipped} skipped) — ${(d.elapsedMs / 1000).toFixed(1)}s${aggStr}`;
```

Then, in the `!options.expanded` (collapsed) branch, replace the inlined per-slot model+elapsed+task construction. The new per-slot line uses `formatSlotMeta` for the `model · elapsed · usage` segment and appends a quoted task preview. Replace the existing `lines.push(\`  ${…[i]} ${idTag}${badge}  ${model}  ·  ${elapsed}  ·  ${taskPreview60}\`);` with:

```ts
      const meta = formatSlotMeta(
        slot as { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
        theme,
      );
      const taskPreview60 = truncateToWidth((slot as { task: string }).task ?? "", 60);
      const idTag = slot.id ? `${theme.fg("dim", `(${slot.id})`)} ` : "";
      lines.push(`  ${theme.fg("dim", `[${i}]`)} ${idTag}${badge}  ${meta}  ·  ${theme.fg("dim", `"${taskPreview60}"`)}`);
```

Leave the null-slot branch (`[i] ✗ failed  ·  (child failed)`) and the `!slot` continue-guard unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all six new collapsed tests green AND every pre-existing `renderSubagentsResult collapsed` test still green (their fixtures omit `usage` → `formatUsage` returns `""` → lines differ only by the quoted task preview + `formatSlotMeta` separator, which the loose-regex assertions still satisfy; the ticket-05 finding-6 badge-alignment test still passes because `formatSlotMeta`'s model segment still starts right after the padded badge at a consistent offset for the id-less fixture).

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): done header Σtok/$Σ + collapsed per-slot meta (model · elapsed · cost · tokens)

renderSubagentsResult collapsed now uses formatSlotMeta (fallback-aware),
appends quoted task preview, and the header carries the aggregate usage.
Mirrors the single subagent card's per-run meta. Null slot unchanged."
```

---

### Task 4: Done-expanded per-child meta line

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`renderSubagentsResult` expanded branch, ~line 720-745)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `formatSlotMeta` (Task 2); the slot variants' fields (`model`/`requestedModel`/`fellBack`/`elapsedMs`/`usage` on done/timedout/aborted/budget; absent on null).
- Produces: the expanded branch prepends a `formatSlotMeta` line above each child's output, for every slot variant that carries `model` + `elapsedMs` (done/timedout/aborted/budget). Null (failed) slots are unchanged (no meta line).

**Render-target cell (done-expanded):** `### [i] (id) status` + meta line `model · elapsed · $cost · Ntok` + output.

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
test("done expanded: prepends a `model · elapsed · $cost · Ntok` meta line above each child output", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        output: "Full audit report\nLine two",
        status: "done",
        id: "a",
        index: 0,
        task: "audit",
        model: "zai/glm-5.2",
        elapsedMs: 34500,
        usage: U(15715, 0.0004),
      },
    ],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 34500,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  const lines = expanded.split("\n");
  assert.match(lines[1] ?? "", /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/, "meta line sits directly under the ### header");
  assert.ok(expanded.includes("Full audit report"), "output preserved under the meta line");
});

test("done expanded: budget + aborted slots get a meta line too (no usage → model · elapsed only)", () => {
  const details: SubagentsToolDetails = {
    results: [
      {
        status: "budget",
        source: "child" as const,
        exhaustion: { kind: "tokens" as const, limit: 1000, actual: 2000 },
        index: 0,
        task: "t-budget",
        model: "zai/glm-5.2",
        elapsedMs: 800,
      },
      { output: "", status: "aborted", index: 1, task: "t-aborted", model: "zai/glm-5.2", elapsedMs: 300 },
    ],
    dispatched: 2,
    skipped: 1,
    elapsedMs: 1100,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  assert.match(expanded, /glm-5\.2 · 0\.8s[\s\S]*skipped/);
  assert.match(expanded, /glm-5\.2 · 0\.3s[\s\S]*aborted/);
});

test("done expanded: null (failed) slot has NO meta line (unchanged failed body)", () => {
  const details: SubagentsToolDetails = {
    results: [null, { output: "ok", status: "done", index: 1, task: "t", model: "zai/glm-5.2", elapsedMs: 100 }],
    dispatched: 1,
    skipped: 0,
    elapsedMs: 100,
  };
  const expanded = renderSubagentsResult({ content: [{ type: "text", text: "x" }], details }, { expanded: true }, THEME);
  const failedBlock = expanded.split("### [1]")[0];
  assert.match(failedBlock, /### \[0\] failed/);
  assert.doesNotMatch(failedBlock, /· .*s ·/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — the expanded branch emits no meta line above the output.

- [ ] **Step 3: Write minimal implementation**

In the expanded branch of `renderSubagentsResult`, the `.map((slot, i) => { … })` currently builds per-slot blocks. Add a meta line to the `done`/`timedout`/`aborted` case AND the `budget` case. Replace the existing `return` for the normal (done/timedout/aborted) case with one that prepends `formatSlotMeta`, and add a meta line to the budget case. Concretely, rewrite the map body:

```ts
    .map((slot, i) => {
      if (slot === null)
        return `${theme.bold(`### [${i}] failed`)}
${theme.fg("dim", "_(null — child failed; re-run via the singular `subagent` tool to see the error)_")}`;
      // Meta line shared by every variant that carries model + elapsedMs
      // (done/timedout/aborted/budget). usage optional → formatSlotMeta degrades.
      const metaLine = formatSlotMeta(
        slot as { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
        theme,
      );
      if (slot.status === "budget") {
        const label = slot.source === "child" ? "child budget" : "batch budget";
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped`)} — ${theme.fg("warning", `${label}: ${slot.exhaustion.kind} ${slot.exhaustion.actual} > ${slot.exhaustion.limit}`)}
${metaLine}`;
      }
      if (slot.status === "aborted") {
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} aborted`)}
${metaLine}
${theme.fg("dim", "_(user-aborted mid-flight)_")}`;
      }
      const output = slot.output || "_(empty output)_";
      return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}`)}
${metaLine}
${theme.fg("toolOutput", output)}`;
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all three new expanded tests green AND the pre-existing `"renderSubagentsResult expanded"` test still green (its `### [0] (a) done` header + output remain; the new meta line is additive and its fixture has no usage → `flash · 3.5s`, which the existing loose assertions don't contradict).

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): done-expanded prepends per-child meta line (model · elapsed · cost · tokens)

Every slot variant carrying model+elapsedMs (done/timedout/aborted/budget)
gets a formatSlotMeta line above its output. Null (failed) slots unchanged."
```

---

### Task 5: `buildLiveTable` — pure live-row builder

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (add exported `buildLiveTable` + `childDispatchIndex` helpers near `formatSlotMeta`)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent` (the registry entry type), `formatModelSeg` (Task 2), `summarizeLatestAction` + `truncateToWidth` (both already imported in `subagents-tool.ts`).
- Produces:
  - `childDispatchIndex(id: string): number` — extracts the trailing `:N` dispatch index from a batch child runId (`${batchId}:${index}`); `NaN` → sorts last.
  - `buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string` — one row per entry, sorted ascending by dispatch index, each `[i] slot ⏱/✓ liveElapsed · currentAction`. Empty input → `""` (header-only, per spec error-handling). PLAIN text (no theme — execute has no Theme; rendered dim by `renderSubagentsResult`'s isPartial branch).

**Render-target cell (running-live per-child row):** `[i] slot ⏱/✓ liveElapsed · currentAction` — `(id)` caller tag omitted (Plan-time decision #3; `InFlightSubagent` has no caller-tag field).

- [ ] **Step 1: Write the failing tests**

Append to `tests/subagents-tool.test.ts`:

```ts
import { buildLiveTable, childDispatchIndex } from "../src/subagents-tool.js";
import type { InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";

const NOW = 10_000;

function live(over: Partial<InFlightSubagent> & { id: string }): InFlightSubagent {
  return { taskPreview: "pt", startedAt: 0, ...over } as InFlightSubagent;
}

test("childDispatchIndex: trailing :N from a batch child runId; NaN-resistant", () => {
  assert.equal(childDispatchIndex("batch-call:3"), 3);
  assert.equal(childDispatchIndex("wf:abc:0"), 0);
  assert.equal(childDispatchIndex("no-colon"), NaN);
});

test("buildLiveTable: empty entries → empty string (header-only)", () => {
  assert.equal(buildLiveTable([], NOW), "");
});

test("buildLiveTable: one running child → `[i] slot ⏱ liveElapsed · currentAction`", () => {
  const rows = buildLiveTable(
    [live({ id: "batch-call:0", model: "zai/glm-5.2", startedAt: 6550, status: "running" })],
    NOW,
  );
  assert.equal(rows, "[0] glm-5.2 ⏱ 3.5s · pt");
});

test("buildLiveTable: completed child shows ✓ glyph + the same meta", () => {
  const rows = buildLiveTable(
    [live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 9000, status: "completed" })],
    NOW,
  );
  assert.equal(rows, "[1] glm-5.2 ✓ 1.0s · pt");
});

test("buildLiveTable: fallback child shows `requested → actual` slot", () => {
  const rows = buildLiveTable(
    [
      live({
        id: "batch-call:0",
        model: "anthropic/claude-opus-4-1",
        resolvedModel: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
        startedAt: 9500,
        status: "running",
      }),
    ],
    NOW,
  );
  assert.equal(rows, "[0] claude-opus-4-1 → glm-5.2 ⏱ 0.5s · pt");
});

test("buildLiveTable: currentAction comes from summarizeLatestAction(history); falls back to task preview", () => {
  const withHist = buildLiveTable(
    [
      live({
        id: "batch-call:0",
        model: "zai/glm-5.2",
        startedAt: 9000,
        history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/a.ts"}' }],
      }),
    ],
    NOW,
  );
  assert.match(withHist, /\[0\] glm-5\.2 ⏱ 1\.0s · .+/);
  assert.notEqual(withHist, "[0] glm-5.2 ⏱ 1.0s · pt", "history-derived action replaces the task-preview fallback");
});

test("buildLiveTable: sorted ascending by dispatch index; defaults to Date.now()", () => {
  const rows = buildLiveTable([
    live({ id: "batch-call:2", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
    live({ id: "batch-call:0", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
    live({ id: "batch-call:1", model: "zai/glm-5.2", startedAt: 0, status: "running" }),
  ]);
  const idxs = rows.split("\n").map((l) => l.slice(1, 2));
  assert.deepEqual(idxs, ["0", "1", "2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — `buildLiveTable` / `childDispatchIndex` not exported.

- [ ] **Step 3: Write minimal implementation**

In `subagents-tool.ts`, add these two helpers (place them right after `formatSlotMeta`):

```ts
import type { InFlightSubagent } from "@repo/pi-agent-ext-core-runtime";
```

(Add `InFlightSubagent` to the existing `@repo/pi-agent-ext-core-runtime` import line at the top of the file — it is exported from the same module as `SubagentInFlightRegistry`.)

```ts
/** Extract the trailing `:N` dispatch index from a batch child runId
 *  (`${batchId}:${index}`). NaN for ids without a numeric suffix (sorts last). */
export function childDispatchIndex(id: string): number {
  const idx = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isFinite(idx) ? idx : NaN;
}

/** Pure live-table builder for the running (isPartial) batch view. One row per
 *  in-flight child, sorted ascending by dispatch index:
 *    `[i] slot ⏱/✓ liveElapsed · currentAction`
 *  - `slot` via {@link formatModelSeg} (fallback-aware; resolved model once known).
 *  - glyph ⏱ while `status !== "completed"`, ✓ once completed (kept in the
 *    registry until endBatch so a finished child still shows its final elapsed).
 *  - `liveElapsed` = `(now - startedAt)/1000` with 1-decimal.
 *  - `currentAction` from {@link summarizeLatestAction}(history), falling back to
 *    the task preview (truncated to 40) when there is no history yet.
 *  PLAIN text (no theme — `execute()` has no Theme; rendered dim by the isPartial
 *  branch of `renderSubagentsResult`). Empty input → "" (header-only). */
export function buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string {
  const sorted = [...entries].sort((a, b) => {
    const ia = childDispatchIndex(a.id);
    const ib = childDispatchIndex(b.id);
    return (Number.isNaN(ia) ? Infinity : ia) - (Number.isNaN(ib) ? Infinity : ib);
  });
  const rows = sorted.map((e) => {
    const idx = childDispatchIndex(e.id);
    const idxLabel = Number.isNaN(idx) ? "?" : String(idx);
    const slot = formatModelSeg(
      e.resolvedModel ?? e.model ?? "default",
      e.requestedModel,
      e.fellBack,
    );
    const glyph = e.status === "completed" ? "✓" : "⏱";
    const elapsed = `${((now - e.startedAt) / 1000).toFixed(1)}s`;
    const action = summarizeLatestAction(e.history) ?? truncateToWidth(e.taskPreview ?? e.workIntent ?? "", 40);
    return `[${idxLabel}] ${slot} ${glyph} ${elapsed} · ${action}`;
  });
  return rows.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — all seven `buildLiveTable` tests green.

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): add pure buildLiveTable for the running (isPartial) batch view

One row per in-flight child: `[i] slot ⏱/✓ liveElapsed · currentAction`,
sorted by dispatch index. Plain text (execute has no Theme). Empty → \"\".
Fallback-aware slot via formatModelSeg; action via summarizeLatestAction."
```

---

### Task 6: Running-header aggregate + `runningUsage` map + `onUpdate` rewrite

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`execute()` — declare `runningUsage`; `dispatchChild`'s `childSpawnOpts` — wire `onUsage`; the `onHistory` closure's `onUpdate` text)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (new tests + UPDATE the existing `"onUpdate emits a single-line 'k/N running · latest'…"` test to the new multi-line contract)

**Interfaces:**
- Consumes: `SpawnSubagentOptions.onUsage` (Task 1); `buildLiveTable` (Task 5); `sumUsage` (Task 2); `options.inFlight.list()` filtered by `batchId === toolCallId`.
- Produces: a local `const runningUsage = new Map<string, AgentUsage>()` in `execute()` (keyed by `childRunId`); `onUsage: (u) => { runningUsage.set(childRunId, u); }` on `childSpawnOpts`; and a rewritten `onUpdate` text = header line `subagents · running/total running · Σtok · $Σ` (Σ from `runningUsage`) + `\n` + `buildLiveTable(batchEntries)`.

**Render-target cell (running-live header):** `subagents · N/M running · Σtok · $Σ` (Σ omitted when zero). The collapsed view shows this header line only; ctrl-o (expanded) shows header + live table — both handled by `renderSubagentsResult`'s existing `isPartial` branch (`text.split("\n")[0]` vs full), which is unchanged.

- [ ] **Step 1: Write the failing tests (and update the existing onUpdate test)**

In `tests/subagents-tool.test.ts`, REPLACE the existing test body:

```ts
test("onUpdate emits a single-line 'k/N running · latest' as children progress", async () => { … });
```

with this updated-contract version (the live header is now multi-line: header + live table; `latest:` is gone from the header):

```ts
test("onUpdate emits a multi-line header + live table: `subagents · k/N running · Σtok · $Σ` then one row per child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const updates: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    updates.push(u.content.map((c) => c.text).join(""));
  };
  const spawn = async (opts: {
    task: string;
    onUsage?: (u: AgentUsage) => void;
    onHistory?: (h: { kind: string; toolName?: string; text?: string }[]) => void;
  }): Promise<SpawnSubagentResult> => {
    opts.onUsage?.(U(500, 0.05));
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "r" }]);
    const idx = Number(opts.task.match(/^#(\d+)/)?.[1] ?? 0);
    inFlight.markCompleted(`batch-call:${idx}`);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute(
    "batch-call",
    { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 },
    NO_SIGNAL,
    onUpdate as never,
    NO_CTX,
  );
  assert.ok(updates.length >= 2, "at least one update per child history tick");
  const first = updates[0];
  const firstHeader = first.split("\n")[0] ?? "";
  assert.match(firstHeader, /^subagents · \d+\/2 running/, "header shows `subagents · k/N running`");
  // child #0 already reported usage (500 tok) before this tick → aggregate present
  assert.match(firstHeader, /500 tok · \$0\.050/, "header carries the Σtok · $Σ aggregate (tokens first)");
  assert.ok(!firstHeader.includes("latest:"), "the old `latest:` label is gone from the header");
  assert.ok(first.includes("[0]"), "the live table row for child #0 is present (multi-line)");
});
```

Then ADD these new tests:

```ts
test("runningUsage map is fed by onUsage and drives the live-header Σ across children", async () => {
  const inFlight = new SubagentInFlightRegistry();
  const headers: string[] = [];
  const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
    headers.push((u.content.map((c) => c.text).join("").split("\n")[0] ?? ""));
  };
  let i = 0;
  const usages = [U(1000, 0.1), U(2000, 0.2)];
  const spawn = async (opts: { task: string; onUsage?: (u: AgentUsage) => void }): Promise<SpawnSubagentResult> => {
    const idx = i++;
    opts.onUsage?.(usages[idx] ?? U(0, 0));
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  await tool.execute("batch-sig", { tasks: [{ task: "#0" }, { task: "#1" }], concurrency: 1 }, NO_SIGNAL, onUpdate as never, NO_CTX);
  const lastHeader = headers[headers.length - 1] ?? "";
  assert.match(lastHeader, /3000 tok · \$0\.300/, "Σ accumulates across both children's onUsage");
});

test("onUpdate is try/caught: a throwing buildLiveTable path never fails the child", async () => {
  const inFlight = new SubagentInFlightRegistry();
  // Sabotage list() to throw mid-onUpdate; the child must still complete.
  const badList = () => {
    throw new Error("boom");
  };
  inFlight.list = badList as never;
  let completed = false;
  const spawn = async (opts: { task: string; onHistory?: (h: { kind: string }[]) => void }): Promise<SpawnSubagentResult> => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  };
  const tool = createSubagentsTool({ cwd: "/repo", spawn: spawn as never, inFlight });
  const res = await tool.execute("batch-throw", { tasks: [{ task: "#0" }] }, NO_SIGNAL, undefined, NO_CTX);
  completed = (res.details.results[0] as { status: string }).status === "done";
  assert.equal(completed, true, "child completed despite a throwing inFlight.list() during onUpdate");
});
```

(`U`, `NO_SIGNAL`, `NO_CTX`, `AgentUsage`, `SpawnSubagentResult` are already in scope in the test file — `U` is the helper added in Task 2; `AgentUsage` is imported in Task 2's test additions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: FAIL — the updated onUpdate test still expects the old single-line `latest:` format; the new Σ-header + live-table tests fail because `onUsage` is not wired on `childSpawnOpts` and the onUpdate text is unchanged.

- [ ] **Step 3: Write minimal implementation**

In `execute()`, declare the running-usage map near the other batch state (`acc`, `gateTripped`, etc.):

```ts
      // Per-child final usage, captured via the additive onUsage callback
      // (fires once at each child's completion). Feeds the running (live)
      // header's Σtok/$Σ. NOTE: onUsage is completion-triggered, so the Σ is
      // "sum over children completed so far" — not a per-token live ticker.
      const runningUsage = new Map<string, AgentUsage>();
```

In `dispatchChild`, inside the `childSpawnOpts` object literal, add an `onUsage` alongside the existing `onModelResolved` / `onModelFallback` / `onHistory`:

```ts
          onUsage: (u) => {
            runningUsage.set(childRunId, u);
          },
```

Then replace the body of the `onHistory` closure's `try { … onUpdate?.(…) }` block. The new text is a header line + a live table (multi-line). Replace the existing block:

```ts
            try {
              const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
              const running = group.filter((e) => e.status !== "completed").length;
              const total = params.tasks.length;
              const agg = sumUsage(runningUsage.values());
              const aggStr = agg.total > 0 ? ` · ${agg.total} tok · $${agg.cost.toFixed(3)}` : "";
              const header = `subagents · ${running}/${total} running${aggStr}`;
              const table = buildLiveTable(group);
              const text = table ? `${header}\n${table}` : header;
              onUpdate?.({
                content: [{ type: "text" as const, text }],
                details: undefined as never,
              });
            } catch {
              // swallowed — onUpdate is diagnostic only (mirrors the singular tool)
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )`
Expected: PASS — the updated onUpdate test + both new tests green; all other tests green. (The existing `renderSubagentsResult isPartial+collapsed shows a compact single-line; expanded shows full` test stays green because it feeds a literal string and only asserts the renderer's line-splitting, which is unchanged.)

- [ ] **Step 5: Full package gate, then commit**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )`
Expected: biome clean, tsc clean, ALL unit tests green (including every pre-existing subagent/subagents test).

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
git commit -m "feat(subagents): running header Σtok/$Σ + multi-line live table via onUsage

execute() keeps a runningUsage Map<runId,AgentUsage> fed by the additive
SpawnSubagentOptions.onUsage (Task 1). The onHistory→onUpdate text is now a
header (`subagents · k/N running · Σtok · $Σ`) + buildLiveTable rows. Stays
try/caught (diagnostic only). Mirrors the single card's per-run meta in the
running state."
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- **Render targets table (3 states):**
  - Running-live header `subagents · N/M running · Σtok · $Σ` → Task 6 (`onUpdate` rewrite).
  - Running-live per-child row `[i] slot ⏱/✓ liveElapsed · currentAction` → Task 5 (`buildLiveTable`) + Task 6 (wired into `onUpdate`). *(`(id)` caller tag intentionally omitted — Plan-time decision #3; `InFlightSubagent` has no caller-tag field.)*
  - Done-collapsed header `batch (X ok · Y failed · Z skipped) — Ts · $Σ · Σtok` → Task 3 (header `aggStr`).
  - Done-collapsed per-child `[i] (id) ✓ model · elapsed · $cost · Ntok · "task"` → Task 3 (`formatSlotMeta` + quoted task). *(`✓` = fixed-width padded badge, preserved — decision #5.)*
  - Done-expanded header (same) → Task 3 (shared header build).
  - Done-expanded per-child `### [i] (id) status` + meta `model · elapsed · $cost · Ntok` + output → Task 4.
- **Components 1–6:** ① `formatUsage` → Task 2. ② `formatSlotMeta` (+ shared `formatModelSeg`) → Task 2. ③ `renderSubagentsResult` rewrite (header + collapsed + expanded) → Tasks 3 + 4. ④ `buildLiveTable` → Task 5. ⑤ `onUpdate` rewrite → Task 6. ⑥ `runningUsage` map + `onUsage` wiring → Task 6 (map/wiring) + Task 1 (the exposed callback). ✅ No gap.
- **Data flow:** Done path (`BatchResultSlot` fields → `formatSlotMeta`, no new plumbing) → Tasks 2–4. Running path (`inFlight.list()` filtered by `batchId` → `buildLiveTable`; aggregate from `runningUsage`) → Tasks 5–6. ✅
- **Error handling:** builders defensive (`formatUsage`/`formatSlotMeta`/`buildLiveTable` degrade; null/budget/aborted preserved — Tasks 3–4) ✅; `buildLiveTable` empty → header-only (Task 5) ✅; `onUpdate` stays try/caught (Task 6 has an explicit throwing-list test) ✅.
- **Testing section:** unit tests for `formatUsage`/`formatSlotMeta`/`buildLiveTable` (Tasks 2, 5) ✅; `renderSubagentsResult` collapsed + expanded across slot variants done/failed(null)/budget/aborted × {with,without usage} × {with,without id} × {fallback,no fallback} (Tasks 3, 4) ✅; existing tests kept green except the one updated in-task (Task 6) ✅.
- **Out of scope:** SDD/commit-scope/watchdog tags — not added (correct, N/A for read-only batch) ✅. Single `subagent` card — untouched ✅.

**2. Placeholder scan** — searched for TBD / TODO / "add appropriate" / "similar to Task" / undefined-type references: **none found.** Every code step contains concrete code; every type referenced (`AgentUsage`, `InFlightSubagent`, `BatchResultSlot`, `SubagentsToolDetails`, `Theme`) is defined in the repo or in an earlier task. The float-sum `0.30000000000000004` in the `sumUsage` test is asserted verbatim (JS float arithmetic), not hand-waved.

**3. Type consistency** — checked names/signatures across tasks:
- `formatUsage(u: AgentUsage | undefined): string` — defined Task 2, used Tasks 2 (inside `formatSlotMeta`) only. ✅
- `formatModelSeg(model, requestedModel?, fellBack?)` — defined Task 2, used by `formatSlotMeta` (Task 2) and `buildLiveTable` (Task 5) with identical arg order. ✅
- `formatSlotMeta(slot, theme)` — defined Task 2, consumed Tasks 3 + 4 with the same slot-shape cast. ✅
- `sumUsage(values): { total; cost }` — defined Task 2, consumed Task 3 (done header) + Task 6 (live header). ✅
- `buildLiveTable(entries, now?)` + `childDispatchIndex(id)` — defined Task 5, consumed Task 6 (`buildLiveTable(group)`). ✅
- `SpawnSubagentOptions.onUsage?: (u: AgentUsage) => void` — defined Task 1, wired Task 6. ✅
- `runningUsage: Map<string, AgentUsage>` — declared Task 6, keyed by `childRunId` (same id used in `inFlight.start({ id: childRunId, … })`). ✅

**Issues found & fixed inline during review:** none required — the plan-time decisions (#1–#6) were encoded up front precisely because they resolve spec/code tensions (one-shot `onUsage`, missing caller-tag field, no-Theme-in-execute, badge-width preservation, Σ order). The single existing test whose contract changes (`onUpdate` single-line) is explicitly updated in Task 6 rather than left to break.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-10-improve-subagents-batch-tui/plans/improve-subagents-batch-tui.md`. Two execution options:

**1. Subagent-Driven Development (recommended)** — dispatch a fresh subagent per task (6 tasks), review between tasks. Best fit here: the tasks are tightly sequential (Task 6 depends on 1 + 5; Tasks 3–4 share a file and a function with 2), pure-render tasks 2–5 are fast isolated cycles, and a per-task review gate catches any drift in the exact meta string format before it compounds.

**2. Inline Execution** — execute the tasks in this session via executing-plans, with checkpoints after Task 1 (the shared-options change) and Task 4 (done-view complete) before the running-view Task 6.

Which approach?
