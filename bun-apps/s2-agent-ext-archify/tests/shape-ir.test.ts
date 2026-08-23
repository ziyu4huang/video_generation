import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSvg } from "../src/svg-model.ts";
import {
  boundsOf,
  formatShapeIR,
  parsePathD,
  toShapeIR,
  UnsupportedPathCommand,
  type ShapeIR,
} from "../src/shape-ir.ts";
import { runArchify, VENDORED_BIN } from "../src/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");
const GOLDEN_DIR = join(PKG_ROOT, "tests", "fixtures", "shape-ir");

/** One vendored example per diagram type — all five are covered. */
const CASES = [
  { type: "architecture", example: "web-app.architecture.json" },
  { type: "workflow", example: "incident-response.workflow.json" },
  { type: "sequence", example: "cache-miss-request.sequence.json" },
  { type: "dataflow", example: "event-stream.dataflow.json" },
  { type: "lifecycle", example: "agent-run.lifecycle.json" },
] as const;

const irs = new Map<string, ShapeIR>();
let workDir = "";

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "archify-shape-ir-"));
  for (const { type, example } of CASES) {
    const out = join(workDir, `${type}.html`);
    const { stdout, status } = await runArchify(
      ["deliver", type, join(EXAMPLES, example), out, "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status, `${example} render (stdout: ${stdout.slice(0, 200)})`).toBe(0);
    const doc = await parseSvg(await Bun.file(out).text());
    irs.set(type, toShapeIR(doc, "light"));
  }
});

describe("parsePathD", () => {
  test("absolute moveto/lineto", () => {
    expect(parsePathD("M 10 20 L 30 40")).toEqual([
      { c: "M", x: 10, y: 20 },
      { c: "L", x: 30, y: 40 },
    ]);
  });

  test("relative commands accumulate", () => {
    expect(parsePathD("m 10 10 l 5 0 l 0 5")).toEqual([
      { c: "M", x: 10, y: 10 },
      { c: "L", x: 15, y: 10 },
      { c: "L", x: 15, y: 15 },
    ]);
  });

  test("H/V become lineto", () => {
    expect(parsePathD("M0 0 H 10 V 20 h -5 v -5")).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 10, y: 0 },
      { c: "L", x: 10, y: 20 },
      { c: "L", x: 5, y: 20 },
      { c: "L", x: 5, y: 15 },
    ]);
  });

  test("implicit lineto after moveto (the SVG repeat rule)", () => {
    expect(parsePathD("M 0 0 10 10 20 20")).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 10, y: 10 },
      { c: "L", x: 20, y: 20 },
    ]);
  });

  test("quadratic is preserved as Q", () => {
    expect(parsePathD("M0 0 Q 5 0 5 5")).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "Q", x1: 5, y1: 0, x: 5, y: 5 },
    ]);
  });

  test("smooth cubic reflects the previous control point", () => {
    const segs = parsePathD("M0 0 C 1 1 2 2 3 3 s 2 2 3 3");
    expect(segs[2]).toEqual({ c: "C", x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
  });

  test("smooth quadratic reflects too", () => {
    const segs = parsePathD("M0 0 Q 1 1 2 2 T 4 4");
    expect(segs[2]).toEqual({ c: "Q", x1: 3, y1: 3, x: 4, y: 4 });
  });

  test("closepath returns to the subpath start", () => {
    const segs = parsePathD("M5 5 L10 5 Z l 1 1");
    expect(segs[2]).toEqual({ c: "Z" });
    expect(segs[3]).toEqual({ c: "L", x: 6, y: 6 });
  });

  test("an arc becomes cubic segments that land on the endpoint", () => {
    const segs = parsePathD("M 0 0 A 10 10 0 0 1 20 0");
    expect(segs[0]).toEqual({ c: "M", x: 0, y: 0 });
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.c === "M" || s.c === "C").toBe(true);
    const last = segs[segs.length - 1]!;
    if (last.c !== "C") throw new Error("expected a cubic tail");
    expect(last.x).toBeCloseTo(20, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  test("sweep direction matches SVG semantics", () => {
    // sweep-flag=1 sweeps in the direction of increasing angle, which with
    // SVG's y-down axes puts the bulge at NEGATIVE y for a left-to-right chord.
    // Verified against WebKit's own SVG engine in arc-reference.test.ts — do
    // not "correct" this by intuition.
    const up = parsePathD("M 0 0 A 10 10 0 0 1 20 0");
    const upYs = up.flatMap((s) => (s.c === "C" ? [s.y1, s.y2, s.y] : []));
    expect(Math.min(...upYs)).toBeLessThan(-9);

    const down = parsePathD("M 0 0 A 10 10 0 0 0 20 0");
    const downYs = down.flatMap((s) => (s.c === "C" ? [s.y1, s.y2, s.y] : []));
    expect(Math.max(...downYs)).toBeGreaterThan(9);
  });

  test("a degenerate arc (zero radius) degrades to a line", () => {
    expect(parsePathD("M0 0 A 0 0 0 0 1 5 5")).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 5, y: 5 },
    ]);
  });

  test("an unsupported command throws with the command and the d", () => {
    // The whole point of this ticket: dropped geometry must never be silent.
    expect(() => parsePathD("M0 0 X 5 5")).toThrow(UnsupportedPathCommand);
    try {
      parsePathD("M0 0 X 5 5");
    } catch (e) {
      expect((e as Error).message).toContain('"X"');
      expect((e as Error).message).toContain("M0 0 X 5 5");
    }
  });

  test("a truncated command throws rather than emitting NaN geometry", () => {
    expect(() => parsePathD("M 10")).toThrow(UnsupportedPathCommand);
  });
});

describe("toShapeIR — synthetic", () => {
  test("applies the ancestor transform chain to geometry", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><g transform="translate(10,20) scale(2)"><rect class="c-backend" x="5" y="5" width="10" height="10"/></g></svg>`
    );
    const ir = toShapeIR(doc, "light");
    expect(ir.nodes).toHaveLength(1);
    const r = ir.nodes[0]!;
    if (r.kind !== "rect") throw new Error("expected a rect");
    expect([r.x, r.y, r.w, r.h]).toEqual([20, 30, 20, 20]);
  });

  test("scales stroke width and font size by the transform", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><g transform="scale(2)"><rect class="c-backend" x="0" y="0" width="4" height="4" stroke-width="1.5"/><text x="1" y="1" font-size="10">hi</text></g></svg>`
    );
    const ir = toShapeIR(doc, "light");
    const rect = ir.nodes.find((n) => n.kind === "rect")!;
    const text = ir.nodes.find((n) => n.kind === "text")!;
    expect(rect.style.strokeWidth).toBe(3);
    if (text.kind !== "text") throw new Error("expected text");
    expect(text.fontSize).toBe(20);
  });

  test("a rotated rect degrades to a polygon instead of a wrong box", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><g transform="rotate(45)"><rect x="0" y="0" width="10" height="10" class="c-backend"/></g></svg>`
    );
    const ir = toShapeIR(doc, "light");
    expect(ir.nodes[0]!.kind).toBe("polygon");
  });

  test("<line> is normalized to a two-segment path", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><line x1="1" y1="2" x2="3" y2="4" class="a-default"/></svg>`
    );
    const ir = toShapeIR(doc, "light");
    const n = ir.nodes[0]!;
    if (n.kind !== "path") throw new Error("expected a path");
    expect(n.segments).toEqual([
      { c: "M", x: 1, y: 2 },
      { c: "L", x: 3, y: 4 },
    ]);
  });

  test("circle becomes an ellipse", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><circle cx="10" cy="20" r="5" class="c-backend"/></svg>`
    );
    const n = toShapeIR(doc, "light").nodes[0]!;
    expect(n).toMatchObject({ kind: "ellipse", cx: 10, cy: 20, rx: 5, ry: 5 });
  });

  test("drops defs content, structural nodes, and the grid plate", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><title>t</title><defs><marker id="m"><polygon points="0,0 1,1 0,2" class="m-default"/></marker></defs><rect width="100%" height="100%" fill="url(#grid)"/><g><rect class="c-backend" x="1" y="1" width="2" height="2"/></g></svg>`
    );
    const ir = toShapeIR(doc, "light");
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0]!.kind).toBe("rect");
  });

  test("resolves currentColor from an ancestor s-* class", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><g class="semantic-sigil s-database"><path class="sigil-fill" d="M0 0 L1 1"/></g></svg>`
    );
    const n = toShapeIR(doc, "light").nodes[0]!;
    // --database-stroke in the light palette is #7c3aed.
    expect(n.style.fill).toEqual({ r: 124, g: 58, b: 237, a: 1 });
  });

  test("the inherited color does not leak to a later sibling subtree", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><g class="s-database"><path class="sigil-fill" d="M0 0 L1 1"/></g><path class="sigil-fill" d="M2 2 L3 3"/></svg>`
    );
    const ir = toShapeIR(doc, "light");
    expect(ir.nodes[0]!.style.fill).toBeTruthy();
    expect(ir.nodes[1]!.style.fill).toBeUndefined();
  });

  test("captures marker-end references", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><path d="M0 0 L1 1" class="a-default" marker-end="url(#arrowhead)"/></svg>`
    );
    expect(toShapeIR(doc, "light").nodes[0]!.markerEnd).toBe("arrowhead");
  });

  test("skips empty text and zero-area rects", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><text x="1" y="1">   </text><rect x="0" y="0" width="0" height="5" class="c-backend"/></svg>`
    );
    expect(toShapeIR(doc, "light").nodes).toHaveLength(0);
  });

  test("preserves paint order", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 100 100"><rect class="c-backend" x="0" y="0" width="1" height="1"/><path class="a-default" d="M0 0 L1 1"/><text x="0" y="0">z</text></svg>`
    );
    expect(toShapeIR(doc, "light").nodes.map((n) => n.kind)).toEqual(["rect", "path", "text"]);
  });
});

describe("toShapeIR — all five vendored diagram types", () => {
  for (const { type } of CASES) {
    test(`${type}: every shape lies inside the viewBox`, () => {
      const ir = irs.get(type)!;
      expect(ir.nodes.length).toBeGreaterThan(10);
      for (const n of ir.nodes) {
        const b = boundsOf(n);
        // A transform composed in the wrong order shows up here immediately.
        expect(b.x, `${type} ${n.kind} x`).toBeGreaterThanOrEqual(-1);
        expect(b.y, `${type} ${n.kind} y`).toBeGreaterThanOrEqual(-1);
        expect(b.x + b.w, `${type} ${n.kind} right`).toBeLessThanOrEqual(ir.width + 1);
        expect(b.y + b.h, `${type} ${n.kind} bottom`).toBeLessThanOrEqual(ir.height + 1);
      }
    });

    test(`${type}: every node carries resolved paint`, () => {
      const ir = irs.get(type)!;
      for (const n of ir.nodes) {
        const painted =
          n.style.fill !== undefined || n.style.stroke !== undefined;
        expect(painted, `${type} ${n.kind} resolved to no paint at all`).toBe(true);
      }
    });

    test(`${type}: matches its golden`, async () => {
      const ir = irs.get(type)!;
      const actual = formatShapeIR(ir);
      const goldenPath = join(GOLDEN_DIR, `${type}.txt`);
      if (process.env.UPDATE_SHAPE_IR_GOLDENS === "1") {
        await Bun.write(goldenPath, actual);
      }
      expect(
        existsSync(goldenPath),
        `missing golden ${goldenPath} — regenerate with UPDATE_SHAPE_IR_GOLDENS=1 bun test`
      ).toBe(true);
      expect(actual).toBe(await Bun.file(goldenPath).text());
    });
  }

  test("theme changes the palette but not the geometry", async () => {
    const out = join(workDir, "theme-check.html");
    await runArchify(
      ["deliver", "architecture", join(EXAMPLES, "web-app.architecture.json"), out, "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    const doc = await parseSvg(await Bun.file(out).text());
    const light = toShapeIR(doc, "light");
    const dark = toShapeIR(doc, "dark");
    expect(dark.nodes.length).toBe(light.nodes.length);
    const geom = (ir: ShapeIR) => ir.nodes.map((n) => JSON.stringify(boundsOf(n)));
    expect(geom(dark)).toEqual(geom(light));
    expect(formatShapeIR(dark)).not.toBe(formatShapeIR(light));
  });
});

process.on("exit", () => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});
