# Task 2 Report — Pure render helpers (`formatUsage`, `formatModelSeg`, `formatSlotMeta`, `sumUsage`)

**Package:** `bun-apps/pi-agent-ext-subagent`
**Branch:** `feat/improve-subagents-batch-tui`
**Task:** 2 of 6 (render-parity improvement to the batch `subagents` TUI card)
**Status:** DONE

## Summary

Added four exported pure render helpers to `src/subagents-tool.ts`, placed
immediately after `batchStatusBadge` (before `renderSubagentsResult`), per the
brief's verbatim implementation. These are DRY primitives shared by the
done-collapsed / done-expanded rewrites (Task 3) and the live-header Σ rewrites
(Task 6). They are PURE: no I/O, no side effects, deterministic, trivially
unit-testable.

`formatSlotMeta` + `formatModelSeg` mirror the single `subagent` card's meta
format (fallback-aware) — render PARITY, so the format strings are contractual.

## Functions (final signatures)

```ts
/** Usage segment: ` · $X.XXX · Ntok` when usage present + non-zero, else "".
 *  Load-bearing: render fixtures omit `usage`, so "" keeps rendered lines
 *  byte-compatible (no phantom spaces/tokens). */
export function formatUsage(u: AgentUsage | undefined): string

/** Fallback-aware model label (theme-free — shared by live table + themed meta).
 *  On fallback: `requested → actual` (both shortModel-ed); else resolved model
 *  shortModel-ed; "default" when empty. */
export function formatModelSeg(model: string, requestedModel?: string, fellBack?: boolean): string

/** Themed `model · elapsed · usage` line for a done/timedout/aborted/budget slot.
 *  `usage` optional → degrades to `model · elapsed`. */
export function formatSlotMeta(
  slot: { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
  theme: Theme,
): string

/** Sum total + cost across any iterable of AgentUsage. Empty → zeros. */
export function sumUsage(values: Iterable<AgentUsage>): { total: number; cost: number }
```

## Implementation (transcribed verbatim, post-biome-format)

```ts
export function formatUsage(u: AgentUsage | undefined): string {
  return u && u.total > 0 ? ` · $${u.cost.toFixed(3)} · ${u.total} tok` : "";
}

export function formatModelSeg(model: string, requestedModel?: string, fellBack?: boolean): string {
  if (fellBack && requestedModel) {
    return `${shortModel(requestedModel) ?? "default"} → ${shortModel(model) ?? "default"}`;
  }
  return shortModel(model) ?? "default";
}

export function formatSlotMeta(
  slot: { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
  theme: Theme,
): string {
  return theme.fg(
    "muted",
    `${formatModelSeg(slot.model, slot.requestedModel, slot.fellBack)} · ${(slot.elapsedMs / 1000).toFixed(
      1,
    )}s${formatUsage(slot.usage)}`,
  );
}

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

`shortModel` (from `@repo/pi-agent-ext-core-runtime`) already returns
`string | undefined` and treats `""` / falsy as `undefined`, so
`formatModelSeg("")` correctly falls through to `"default"`. `Theme` is already
imported from `@earendil-works/pi-coding-agent` at the top of the module; no new
imports were required.

## Test cases added (`tests/subagents-tool.test.ts`)

A `U(total, cost)` AgentUsage factory plus four tests (identity-theme `THEME`
const already defined at the top of the render-test section):

### 1. `formatUsage` — empty/zero/3-decimal-cost
```ts
test("formatUsage: empty when no usage or zero total; else ` · $cost · Ntok` (3-decimal cost)", () => {
  assert.equal(formatUsage(undefined), "");
  assert.equal(formatUsage(U(0, 0)), "");
  assert.equal(formatUsage(U(15715, 0.0004)), " · $0.000 · 15715 tok");
  assert.equal(formatUsage(U(1000, 0.5)), " · $0.500 · 1000 tok");
});
```
**Load-bearing case:** `formatUsage(undefined) === ""` and
`formatUsage(U(0,0)) === ""` — the empty-string contract that keeps existing
render fixtures byte-compatible (the Task-1 reviewer's flagged invariant). Cost
formatted with `.toFixed(3)` (3-decimal) regardless of magnitude.

### 2. `formatModelSeg` — prefix shortening, fallback, default
```ts
test("formatModelSeg: shortens provider prefix; `requested → actual` on fallback; default fallback", () => {
  assert.equal(formatModelSeg("zai/glm-5.2"), "glm-5.2");
  assert.equal(formatModelSeg("tier:small"), "tier:small");
  assert.equal(
    formatModelSeg("anthropic/claude-opus-4-1", "anthropic/claude-opus-4-1", true),
    "claude-opus-4-1 → claude-opus-4-1",
  );
  assert.equal(formatModelSeg("zai/glm-5.2", "anthropic/claude-opus-4-1", true), "claude-opus-4-1 → glm-5.2");
  assert.equal(formatModelSeg(""), "default");
});
```
Covers: provider-prefix drop, no-slash passthrough, same-model fallback,
different-model fallback, and the empty → `"default"` fallthrough.

### 3. `formatSlotMeta` — themed composition + defensive on missing usage
```ts
test("formatSlotMeta: themed `model · elapsed · usage`; defensive on missing usage", () => {
  const meta = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500, usage: U(15715, 0.0004) }, THEME);
  assert.equal(meta, "glm-5.2 · 34.5s · $0.000 · 15715 tok");
  const noUsage = formatSlotMeta({ model: "zai/glm-5.2", elapsedMs: 34500 }, THEME);
  assert.equal(noUsage, "glm-5.2 · 34.5s");
  const fb = formatSlotMeta(
    {
      model: "zai/glm-5.2",
      requestedModel: "anthropic/claude-opus-4-1",
      fellBack: true,
      elapsedMs: 1000,
      usage: U(10, 0.001),
    },
    THEME,
  );
  assert.equal(fb, "claude-opus-4-1 → glm-5.2 · 1.0s · $0.001 · 10 tok");
});
```
Three cases: full meta, usage-omitted (`model · elapsed` only — byte-compatible
degradation), and fallback composition. Elapsed formatted with `.toFixed(1)`.

### 4. `sumUsage` — aggregation + empty-zeros
```ts
test("sumUsage: sums total+cost across an iterable; empty → zeros", () => {
  assert.deepEqual(sumUsage([]), { total: 0, cost: 0 });
  assert.deepEqual(sumUsage([U(100, 0.1), U(200, 0.2)]), { total: 300, cost: 0.30000000000000004 });
  assert.deepEqual(sumUsage(new Map([["a", U(50, 0.05)]]).values()), { total: 50, cost: 0.05 });
});
```
Covers: empty → zeros (feeds both done-header and live-header when no usage
reported), array aggregation with the IEEE-754 floating-point sum
(`0.1 + 0.2 = 0.30000000000000004` — asserted verbatim, not rounded), and
non-array iterable (a `Map.values()` iterator — exercises the `Iterable<AgentUsage>`
contract the live-header Σ will rely on).

## Test command + output

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )
```
```
(pass) formatUsage: empty when no usage or zero total; else ` · $cost · Ntok` (3-decimal cost) [0.03ms]
(pass) formatModelSeg: shortens provider prefix; `requested → actual` on fallback; default fallback [0.02ms]
(pass) formatSlotMeta: themed `model · elapsed · usage`; defensive on missing usage [0.04ms]
(pass) sumUsage: sums total+cost across an iterable; empty → zeros [0.03ms]

 43 pass
 0 fail
Ran 43 tests across 1 file. [257.00ms]
```
All 43 tests pass (4 new + 39 pre-existing untouched). The RED phase was
confirmed first: pre-implementation `bun test` failed with
`SyntaxError: Export named 'sumUsage' not found in module …subagents-tool.ts`
(the expected import-error failure mode).

## Gate result

```bash
( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )
```
- `bun run check` (= `biome check .`): **clean** — `Checked 60 files. No fixes applied.`
- `bun run build` (= `bunx tsc`): **clean** — no diagnostics.

Note: initial `bun run check` flagged formatting (line-length wrapping in the new
`formatSlotMeta` template, the long `formatModelSeg` assertion line, and an
import-order merge for the new `AgentUsage` type import). Resolved by running
`bunx biome check --write src/subagents-tool.ts tests/subagents-tool.test.ts`
(safe auto-fixes only — semantics unchanged; tests re-verified green after).

## Commit SHA

- **Base:** `725ec68d` (T1 audit-trail commit)
- **Head:** `bd3f4793` — `feat(subagent): batch-tui pure render helpers — formatUsage/formatModelSeg/formatSlotMeta/sumUsage (T2)`

Staged exactly the two required source files:
`bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` +
`bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (2 files changed,
107 insertions). No `.planning/` files committed (controller commits the audit
trail separately).

## Notes for downstream tasks

- `formatUsage` returns `""` for absent/zero usage — **do not** strip it when
  composing meta lines; the empty string is the byte-compat contract. Any new
  render line that wants usage should compose as `…${formatUsage(usage)}` (same
  pattern `formatSlotMeta` uses).
- `formatModelSeg` is theme-free by design; the themed wrapping (`theme.fg("muted", …)`)
  lives in `formatSlotMeta`. The live table (Task 6) should call `formatModelSeg`
  directly to avoid double-wrapping.
- `sumUsage` returns a plain `{ total, cost }` — compatible with the existing
  `acc` accumulator shape (`{ tokens: { total }, cost }`) used by the batch soft
  gate in `execute()`, modulo the nesting; downstream header code should read
  `.total` / `.cost` off the returned object directly.
