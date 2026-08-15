import { test } from "bun:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { capWidth, ellipsizeToWidth } from "../src/render-width.js";

// ── effort 2026-08-15-subagent-tui-display (ticket 01): shared truncation helper ──
// The helper module owns THREE invariants for every pure render adopter:
//   1. terminal-COLUMN budgets (East-Asian double-width counted via visibleWidth),
//   2. ONE trailing `…` INSIDE the budget whenever content is cut,
//   3. graceful floor at degenerate widths — never empty, never a crash.

test("capWidth keeps the constant when width is undefined or non-finite (defaulted callers stay byte-identical)", () => {
  assert.equal(capWidth(80), 80);
  assert.equal(capWidth(60, undefined), 60);
  assert.equal(capWidth(80, Number.NaN), 80);
  assert.equal(capWidth(80, Number.POSITIVE_INFINITY), 80);
  assert.equal(capWidth(80, Number.NEGATIVE_INFINITY), 80);
});

test("capWidth is min(constant, width): a caller width only ever NARROWS the cap", () => {
  assert.equal(capWidth(80, 40), 40);
  assert.equal(capWidth(80, 80), 80);
  // At wide width the CONSTANT binds (upper-bound semantics, ticket 01).
  assert.equal(capWidth(60, 120), 60);
  assert.equal(capWidth(200, 200), 200);
  assert.equal(capWidth(200, 1000), 200);
});

test("capWidth floors fractional widths (terminal columns are integers)", () => {
  assert.equal(capWidth(80, 80.9), 80);
  assert.equal(capWidth(80, 40.5), 40);
  assert.equal(capWidth(60, 0.9), 0);
});

test("ellipsizeToWidth returns content verbatim when it already fits (empty stays empty)", () => {
  assert.equal(ellipsizeToWidth("hello", 80), "hello");
  assert.equal(ellipsizeToWidth("", 80), "");
  assert.equal(ellipsizeToWidth("exactly-40-cols-…", 40), "exactly-40-cols-…");
});

test("ellipsizeToWidth cuts with ONE trailing `…` inside the column budget", () => {
  const out = ellipsizeToWidth("x".repeat(120), 80);
  assert.equal(out, `${"x".repeat(79)}…`);
  assert.equal(visibleWidth(out), 80, "exactly at budget");
  assert.equal(out.split("…").length - 1, 1, "exactly one ellipsis");
  // A width that equals the content width does NOT cut (no spurious ellipsis).
  assert.equal(ellipsizeToWidth("x".repeat(80), 80), "x".repeat(80));
});

test("ellipsizeToWidth degrades gracefully at degenerate widths 0-3 (never crashes, never overlong at 1-3)", () => {
  const s = "abcdef";
  // Width 1: the smallest clean cut signal is the bare `…` (width 1, exact budget).
  assert.equal(ellipsizeToWidth(s, 1), "…");
  assert.equal(visibleWidth(ellipsizeToWidth(s, 1)), 1);
  // Width 2: one char + `…` — still within budget.
  assert.equal(ellipsizeToWidth(s, 2), "a…");
  // Width 3: two chars + `…`.
  assert.equal(ellipsizeToWidth(s, 3), "ab…");
  for (const w of [1, 2, 3]) {
    const out = ellipsizeToWidth(s, w);
    assert.ok(visibleWidth(out) <= w, `width ${w}: never overlong`);
    assert.ok(out.length > 0, `width ${w}: never empty`);
    assert.ok(out.endsWith("…"), `width ${w}: cut signal present`);
  }
  // Width 0 / negative: must not crash; degrade to the bare `…` signal.
  assert.equal(ellipsizeToWidth(s, 0), "…");
  assert.equal(ellipsizeToWidth(s, -5), "…");
});

test("ellipsizeToWidth is CJK double-width aware: CJK-only never exceeds the budget", () => {
  // Each CJK char occupies 2 terminal columns.
  const cjk = "你好世界再见谢谢".repeat(30); // 8 chars × 30 × 2 = 480 columns
  for (const w of [40, 80, 120, 200]) {
    const out = ellipsizeToWidth(cjk, w);
    assert.ok(visibleWidth(out) <= w, `width ${w}: CJK-only within budget`);
    if (visibleWidth(out) < 480) assert.ok(out.endsWith("…"), `width ${w}: cut marked`);
    assert.equal(out.split("…").length - 1, 1, `width ${w}: exactly one ellipsis`);
  }
  // Exact pins: the trailing wide char is DROPPED rather than overshooting.
  assert.equal(ellipsizeToWidth("你好世界", 5), "你好…"); // 2+2+1 = 5
  assert.equal(ellipsizeToWidth("你好世界", 3), "你…"); // 2+1 = 3 (世 would overshoot)
});

test("ellipsizeToWidth handles mixed CJK + ASCII by column budget, not char count", () => {
  const mixed = `你好${"x".repeat(30)}`; // 4 + 30 = 34 columns
  assert.equal(ellipsizeToWidth(mixed, 10), "你好xxxxx…"); // 2+2+5+1 = 10
  const mixed2 = `${"x".repeat(30)}你好`; // 30 + 4 = 34 columns
  const out = ellipsizeToWidth(mixed2, 10);
  assert.equal(visibleWidth(out), 10);
  assert.ok(out.endsWith("…"), "cut marked");
  // Fits → verbatim, even with double-width chars inside.
  assert.equal(ellipsizeToWidth("你好x", 10), "你好x");
});
