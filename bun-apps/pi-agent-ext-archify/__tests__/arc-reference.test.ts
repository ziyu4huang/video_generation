import { describe, expect, test } from "bun:test";
import { parsePathD, type Seg } from "../lib/shape-ir.ts";

/**
 * Ground-truth check for the SVG-arc → cubic-BÃ©zier conversion in shape-ir.ts,
 * measured against a REAL SVG engine rather than against our own reasoning.
 *
 * `Bun.WebView` (Bun 1.4) drives the system WebKit with nothing to install —
 * measured 356 ms cold on the development machine — so this needs no Playwright,
 * no chromium download, and no skip gate. It exists because arc conversion is
 * the one piece of geometry in this package that is easy to get plausibly,
 * silently wrong: endpoint→centre parameterization has four sign conventions
 * and an intuition-defying sweep direction. An earlier version of the sibling
 * test asserted the WRONG bulge direction; the engine settled it.
 */

const CASES = [
  "M 0 0 A 10 10 0 0 1 20 0", // semicircle, sweep=1 (bulges to negative y)
  "M 0 0 A 10 10 0 0 0 20 0", // semicircle, sweep=0 (mirror)
  "M 0 0 A 10 10 0 1 1 20 0", // large-arc flag set
  "M 0 0 A 10 20 0 0 1 20 0", // unequal radii
  "M 0 0 A 10 10 45 0 1 14 14", // x-axis rotation
  "M 10 10 a 6 6 0 0 1 12 0", // relative form
  "M 0 0 A 4 4 0 0 1 20 0", // radii too small -> spec-mandated scale-up
];

/** Flatten our Segs by dense sampling so a bbox can be compared. */
function bboxOf(segs: Seg[]): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  let cx = 0;
  let cy = 0;
  const cubic = (p: number[][], t: number): [number, number] => {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [
      w.reduce((a, k, i) => a + k * p[i]![0]!, 0),
      w.reduce((a, k, i) => a + k * p[i]![1]!, 0),
    ];
  };
  for (const s of segs) {
    if (s.c === "Z") continue;
    if (s.c === "M" || s.c === "L") {
      xs.push(s.x);
      ys.push(s.y);
      cx = s.x;
      cy = s.y;
      continue;
    }
    if (s.c === "C") {
      for (let t = 0; t <= 1; t += 0.002) {
        const [x, y] = cubic([[cx, cy], [s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]], t);
        xs.push(x);
        ys.push(y);
      }
      cx = s.x;
      cy = s.y;
      continue;
    }
    xs.push(s.x1, s.x);
    ys.push(s.y1, s.y);
    cx = s.x;
    cy = s.y;
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

describe("arc conversion vs the system SVG engine (Bun.WebView)", () => {
  test("every arc form matches WebKit's own getBBox", async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="-60 -60 240 240">` +
      CASES.map((d) => `<path d="${d}" fill="none" stroke="black"/>`).join("") +
      `</svg>`;
    const page = `<body style="margin:0">${svg}`;

    await using view = new Bun.WebView({ width: 500, height: 500 });
    await view.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const reference = JSON.parse(
      await view.evaluate(
        `JSON.stringify([...document.querySelectorAll('path')].map(p => { const b = p.getBBox(); return [b.x, b.y, b.width, b.height]; }))`
      )
    ) as [number, number, number, number][];

    expect(reference).toHaveLength(CASES.length);
    CASES.forEach((d, i) => {
      const ours = bboxOf(parsePathD(d));
      const ref = reference[i]!;
      for (let k = 0; k < 4; k++) {
        // 0.2 user units on shapes 12–20 units across. The residual is our
        // sampling resolution, not the conversion: getBBox solves curve
        // extrema exactly, while this harness samples them.
        expect(
          Math.abs(ours[k]! - ref[k]!),
          `${d} bbox[${k}]: ours=${ours[k]!.toFixed(3)} webkit=${ref[k]!.toFixed(3)}`
        ).toBeLessThan(0.2);
      }
    });
  });
});
