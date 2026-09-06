import { describe, expect, test } from "bun:test";
import { STREAMING_EXPANDED_TAIL, viewportTraceTail } from "../src/agent-trace-display.js";

/**
 * tui-cc-parity-2 ticket 01 — the streaming-expanded trace cap is a FUNCTION
 * of terminal height, not a constant. The #1104 flicker rule is preserved:
 * the box (2-line header + ellipsis + tail) must fit the viewport, and the
 * cap must never vary per tick (rows only change on resize).
 */
describe("viewportTraceTail", () => {
  test("unknown/non-finite rows → fixed STREAMING_EXPANDED_TAIL (headless/print/tests)", () => {
    expect(viewportTraceTail(undefined)).toBe(STREAMING_EXPANDED_TAIL);
    expect(viewportTraceTail(0)).toBe(STREAMING_EXPANDED_TAIL);
    expect(viewportTraceTail(-5)).toBe(STREAMING_EXPANDED_TAIL);
    expect(viewportTraceTail(Number.NaN)).toBe(STREAMING_EXPANDED_TAIL);
  });

  test("clamps to [8, 28] with a 14-row chrome reserve", () => {
    // tall terminal → max
    expect(viewportTraceTail(80)).toBe(28);
    expect(viewportTraceTail(200)).toBe(28);
    // probe terminal (36 rows) → 22 (was 16 fixed — the CC-gap this closes)
    expect(viewportTraceTail(36)).toBe(22);
    // mid terminal
    expect(viewportTraceTail(30)).toBe(16); // ≈ the old fixed cap
    // short terminal → shrinks below the old fixed cap (fits, no fullRender)
    expect(viewportTraceTail(24)).toBe(10);
    // floor
    expect(viewportTraceTail(12)).toBe(8);
    expect(viewportTraceTail(5)).toBe(8);
  });

  test("opts override min/max/reserved", () => {
    expect(viewportTraceTail(36, { min: 4, max: 10 })).toBe(10);
    expect(viewportTraceTail(36, { reserved: 20 })).toBe(16);
  });

  test("monotone in rows (taller terminal never shows less)", () => {
    let prev = -Infinity;
    for (let rows = 1; rows <= 80; rows += 1) {
      const t = viewportTraceTail(rows);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
