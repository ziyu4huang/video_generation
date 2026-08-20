import { test } from "bun:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { capWidth, ellipsizeMidToWidth, ellipsizeToWidth } from "../src/render-width.js";

// ── effort 2026-08-15-subagent-tui-display (ticket 01): shared truncation helper,
//    ported home to core-runtime 2026-08-19 (deferred prize: every pure render
//    site that clips a line goes through this ONE surface).
// The helper module owns THREE invariants for every pure render adopter:
//   1. terminal-COLUMN budgets (East-Asian double-width counted via visibleWidth),
//   2. ONE ellipsis INSIDE the budget whenever content is cut,
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

// ── ellipsizeMidToWidth (2026-08-19): the mid-ellipsis counterpart adopted by
//    tool-action-label's shapeTarget for non-command targets. Same invariants as
//    ellipsizeToWidth but the cut marker sits BETWEEN head and tail columns.

test("ellipsizeMidToWidth returns content verbatim when it already fits (empty stays empty)", () => {
  assert.equal(ellipsizeMidToWidth("hello", 80), "hello");
  assert.equal(ellipsizeMidToWidth("", 80), "");
});

test("ellipsizeMidToWidth keeps legacy ASCII mid semantics: ceil/floor head-tail split around one `…`", () => {
  // Legacy truncateMid: head = ceil((max-1)/2), tail = floor((max-1)/2).
  const out = ellipsizeMidToWidth("x".repeat(120), 50);
  assert.equal(out, `${"x".repeat(25)}…${"x".repeat(24)}`); // 25 + 1 + 24 = 50
  assert.equal(visibleWidth(out), 50, "exactly at budget");
  assert.equal(out.split("…").length - 1, 1, "exactly one ellipsis");
  // A width that equals the content width does NOT cut.
  assert.equal(ellipsizeMidToWidth("x".repeat(50), 50), "x".repeat(50));
  // Asymmetry is preserved at odd content budgets: head gets the extra column.
  assert.equal(ellipsizeMidToWidth("x".repeat(120), 7), `${"x".repeat(3)}…${"x".repeat(3)}`);
});

test("ellipsizeMidToWidth degrades gracefully at degenerate widths (never crashes, never empty, one `…`)", () => {
  const s = "abcdef";
  assert.equal(ellipsizeMidToWidth(s, 1), "…");
  assert.equal(ellipsizeMidToWidth(s, 0), "…");
  assert.equal(ellipsizeMidToWidth(s, -5), "…");
  for (const w of [2, 3, 4]) {
    const out = ellipsizeMidToWidth(s, w);
    assert.ok(visibleWidth(out) <= w, `width ${w}: never overlong`);
    assert.ok(out.length > 0, `width ${w}: never empty`);
    assert.equal(out.split("…").length - 1, 1, `width ${w}: exactly one ellipsis`);
  }
});

test("ellipsizeMidToWidth is CJK double-width aware: never exceeds the budget, wide chars stay whole", () => {
  const cjk = "你好世界再见谢谢".repeat(30); // 480 columns
  for (const w of [40, 80, 120]) {
    const out = ellipsizeMidToWidth(cjk, w);
    assert.ok(visibleWidth(out) <= w, `width ${w}: within budget`);
    assert.equal(out.split("…").length - 1, 1, `width ${w}: exactly one ellipsis`);
    assert.ok(out.startsWith("你"), `width ${w}: head preserved from the start`);
    assert.ok(out.endsWith("…") === false || visibleWidth(out) <= w, `width ${w}: sanity`);
  }
  // Exact pin: budget 9 → content 8 cols → head 4 (你好), tail 4 (two CJK),
  // total 4+1+4 = 9. A straddling wide char is dropped, never overshoot.
  const out9 = ellipsizeMidToWidth(cjk, 9);
  assert.equal(visibleWidth(out9), 9);
  assert.equal(out9.split("…").length - 1, 1);
});

test("ellipsizeMidToWidth handles mixed CJK + ASCII by column budget", () => {
  const mixed = `头${"x".repeat(40)}尾`; // 2 + 40 + 2 = 44 columns
  const out = ellipsizeMidToWidth(mixed, 20);
  // head=10 (头 + 8x), tail=9 (尾 + 7x) → 10+1+9 = 20 exactly.
  assert.equal(out, `头${"x".repeat(8)}…${"x".repeat(7)}尾`);
  assert.equal(visibleWidth(out), 20);
});
