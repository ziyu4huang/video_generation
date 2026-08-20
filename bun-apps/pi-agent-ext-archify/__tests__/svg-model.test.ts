import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  applyMatrix,
  attr,
  classList,
  IDENTITY,
  multiply,
  numAttr,
  parseSvg,
  parseTransform,
  type SvgNode,
} from "../lib/svg-model.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(PKG_ROOT, "ir", "pi-agent-ext-webui-v31.architecture.html");

/**
 * Independent census of the committed artifact (counted with a separate
 * tokenizer on 2026-08-21). If the artifact is ever re-rendered these numbers
 * move together — but they must always agree with each other.
 */
const CENSUS: Record<string, number> = {
  text: 99,
  rect: 88,
  g: 73,
  path: 48,
  title: 22,
  circle: 14,
  marker: 4,
  polygon: 4,
  ellipse: 3,
  svg: 1,
  desc: 1,
  defs: 1,
  pattern: 1,
};
const CENSUS_TOTAL = Object.values(CENSUS).reduce((a, b) => a + b, 0); // 359

describe("parseTransform", () => {
  test("absent / empty yields identity", () => {
    expect(parseTransform(undefined)).toEqual(IDENTITY);
    expect(parseTransform("")).toEqual(IDENTITY);
  });

  test("translate moves a point", () => {
    expect(applyMatrix(parseTransform("translate(10, 5)"), 1, 2)).toEqual([11, 7]);
  });

  test("translate with one argument defaults y to 0", () => {
    expect(applyMatrix(parseTransform("translate(10)"), 1, 2)).toEqual([11, 2]);
  });

  test("scale with one argument is uniform", () => {
    expect(applyMatrix(parseTransform("scale(3)"), 2, 4)).toEqual([6, 12]);
  });

  test("rotate(90) maps (1,0) to (0,1)", () => {
    const [x, y] = applyMatrix(parseTransform("rotate(90)"), 1, 0);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  test("rotate about a centre leaves the centre fixed", () => {
    const [x, y] = applyMatrix(parseTransform("rotate(37, 5, 7)"), 5, 7);
    expect(x).toBeCloseTo(5, 10);
    expect(y).toBeCloseTo(7, 10);
  });

  test("composes left-to-right like SVG", () => {
    // translate then scale: the scale applies in the translated frame.
    const m = parseTransform("translate(10, 0) scale(2)");
    expect(applyMatrix(m, 3, 0)).toEqual([16, 0]);
  });

  test("matrix(...) is taken verbatim", () => {
    expect(applyMatrix(parseTransform("matrix(2,0,0,2,1,1)"), 1, 1)).toEqual([3, 3]);
  });

  test("an unmodelled function is ignored, not thrown", () => {
    expect(applyMatrix(parseTransform("skewX(20) translate(4,4)"), 0, 0)).toEqual([4, 4]);
  });
});

describe("multiply", () => {
  test("identity is neutral", () => {
    const m = parseTransform("translate(3,4) scale(2)");
    expect(multiply(IDENTITY, m)).toEqual(m);
    expect(multiply(m, IDENTITY)).toEqual(m);
  });
});

describe("parseSvg — synthetic", () => {
  test("preserves document order across DIFFERING sibling tags", async () => {
    // This is the exact property Bun.XML measurably loses (see svg-model.ts D2).
    // Asserted explicitly so a future 'optimization' back to a DOM-map parser
    // fails here instead of silently reordering paint order.
    const doc = await parseSvg(
      `<svg viewBox="0 0 10 10"><rect id="r1"/><path id="p1"/><rect id="r2"/></svg>`
    );
    expect(doc.nodes.map((n) => attr(n, "id") ?? n.tag)).toEqual(["svg", "r1", "p1", "r2"]);
  });

  test("composes transforms down the ancestor chain", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 10 10"><g transform="translate(10,0)"><g transform="translate(0,5)"><rect id="deep"/></g></g></svg>`
    );
    const deep = doc.nodes.find((n) => attr(n, "id") === "deep")!;
    expect(applyMatrix(deep.ctm, 0, 0)).toEqual([10, 5]);
    expect(deep.depth).toBe(3);
  });

  test("flags the <defs> subtree as defOnly", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 10 10"><defs><marker id="m"><polygon id="head"/></marker></defs><rect id="painted"/></svg>`
    );
    const byId = (id: string) => doc.nodes.find((n) => attr(n, "id") === id)!;
    expect(byId("m").defOnly).toBe(true);
    expect(byId("head").defOnly).toBe(true);
    expect(byId("painted").defOnly).toBe(false);
  });

  test("attaches text to the innermost open element", async () => {
    const doc = await parseSvg(
      `<svg viewBox="0 0 10 10"><text id="t">hello <tspan id="s">world</tspan></text></svg>`
    );
    const byId = (id: string) => doc.nodes.find((n) => attr(n, "id") === id)!;
    expect(byId("t").text.trim()).toBe("hello");
    expect(byId("s").text).toBe("world");
  });

  test("reads dimensions from viewBox despite HTMLRewriter lowercasing", async () => {
    const doc = await parseSvg(`<svg viewBox="0 0 640 480"><rect/></svg>`);
    expect([doc.width, doc.height]).toEqual([640, 480]);
    // The lowercasing is real — assert it so the `attr()` indirection is
    // provably load-bearing rather than decorative.
    expect(doc.nodes[0]!.attrs["viewbox"]).toBe("0 0 640 480");
    expect(doc.nodes[0]!.attrs["viewBox"]).toBeUndefined();
  });

  test("falls back to width/height attributes without a viewBox", async () => {
    const doc = await parseSvg(`<svg width="300" height="150"><rect/></svg>`);
    expect([doc.width, doc.height]).toEqual([300, 150]);
  });

  test("boolean attributes (invalid XML) parse fine", async () => {
    // The second reason Bun.XML cannot be used on archify output.
    const doc = await parseSvg(
      `<svg viewBox="0 0 10 10"><g data-legend-bridge><text data-detail-anchor x="1">x</text></g></svg>`
    );
    const t = doc.nodes.find((n) => n.tag === "text")!;
    expect("data-detail-anchor" in t.attrs).toBe(true);
    expect(numAttr(t, "x")).toBe(1);
  });

  test("ignores markup outside the <svg> subtree", async () => {
    const doc = await parseSvg(
      `<html><body><div><rect id="decoy"/></div><svg viewBox="0 0 4 4"><rect id="real"/></svg></body></html>`
    );
    expect(doc.nodes.map((n) => attr(n, "id") ?? n.tag)).toEqual(["svg", "real"]);
  });
});

describe("parseSvg — the committed 629 KB artifact", () => {
  test("matches the independent element census exactly", async () => {
    const doc = await parseSvg(await Bun.file(ARTIFACT).text());
    const counts: Record<string, number> = {};
    for (const n of doc.nodes) counts[n.tag] = (counts[n.tag] ?? 0) + 1;
    expect(counts).toEqual(CENSUS);
    expect(doc.nodes.length).toBe(CENSUS_TOTAL);
  });

  test("reports the artifact's viewBox dimensions", async () => {
    const doc = await parseSvg(await Bun.file(ARTIFACT).text());
    expect([doc.width, doc.height]).toEqual([1450, 726]);
  });

  test("root is the <svg> at depth 0 and nesting never goes negative", async () => {
    const doc = await parseSvg(await Bun.file(ARTIFACT).text());
    expect(doc.nodes[0]!.tag).toBe("svg");
    expect(doc.nodes[0]!.depth).toBe(0);
    for (const n of doc.nodes) expect(n.depth).toBeGreaterThanOrEqual(0);
  });

  test("captures label text and the archify class vocabulary", async () => {
    const doc = await parseSvg(await Bun.file(ARTIFACT).text());
    const texts = doc.nodes.filter((n: SvgNode) => n.tag === "text");
    expect(texts.some((n) => n.text.includes("Agent side"))).toBe(true);
    const classes = new Set(doc.nodes.flatMap(classList));
    expect(classes.has("c-region")).toBe(true);
    expect(classes.has("t-primary")).toBe(true);
    expect(classes.has("m-default")).toBe(true);
  });

  test("marker polygons are defOnly; painted rects are not", async () => {
    const doc = await parseSvg(await Bun.file(ARTIFACT).text());
    const polys = doc.nodes.filter((n) => n.tag === "polygon");
    expect(polys.length).toBe(4);
    expect(polys.every((n) => n.defOnly)).toBe(true);
    expect(doc.nodes.some((n) => n.tag === "rect" && !n.defOnly)).toBe(true);
  });
});
