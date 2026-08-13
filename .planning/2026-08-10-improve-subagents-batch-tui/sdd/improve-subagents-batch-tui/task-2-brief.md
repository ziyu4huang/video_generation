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

