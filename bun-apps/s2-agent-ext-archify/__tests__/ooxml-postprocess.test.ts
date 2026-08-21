/**
 * ooxml-postprocess.test.ts — `<a:path fill="none">` lands on stroke-only shapes
 * and NOWHERE else.
 *
 * The scoping is the whole risk. Applying `fill="none"` to every path would
 * turn every filled custGeom — node bodies, legend chips, arrowheads — into an
 * outline, which is a worse defect than the one being fixed and would sail past
 * a test that only counted attributes.
 */
import { describe, expect, test } from "bun:test";
import { patchPptxStrokeOnlyPaths, patchStrokeOnlyPaths } from "../lib/ooxml-postprocess.ts";
import { readZipEntries, readZipText } from "../lib/read-zip.ts";
import { writeZip } from "../lib/write-zip.ts";

/** A `<p:sp>` with one custGeom path and the given fill/line properties. */
function shape(fill: string, line = '<a:ln w="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'): string {
  return (
    "<p:sp><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"10\" cy=\"10\"/></a:xfrm>" +
    '<a:custGeom><a:pathLst><a:path w="10" h="10">' +
    '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo>' +
    "</a:path></a:pathLst></a:custGeom>" +
    fill +
    line +
    "</p:spPr></p:sp>"
  );
}

const NO_FILL = "<a:noFill/>";
const SOLID = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>';

describe("patchStrokeOnlyPaths", () => {
  test("adds fill=none to a path inside a no-fill shape", () => {
    const { xml, paths } = patchStrokeOnlyPaths(shape(NO_FILL));
    expect(paths).toBe(1);
    expect(xml).toContain('<a:path fill="none" w="10" h="10">');
  });

  test("leaves a FILLED shape's path alone — the load-bearing negative", () => {
    const { xml, paths } = patchStrokeOnlyPaths(shape(SOLID));
    expect(paths).toBe(0);
    expect(xml).not.toContain('fill="none"');
  });

  test("a shape with no fill element at all is left alone", () => {
    // An absent fill means "inherit", which is not the same as noFill and is
    // exactly the ambiguity `pptx-shapes.ts` stopped emitting.
    const { paths } = patchStrokeOnlyPaths(shape(""));
    expect(paths).toBe(0);
  });

  test("<a:noFill/> inside <a:ln> does NOT make the shape stroke-only", () => {
    // A filled shape with an invisible outline: the line's noFill must not be
    // mistaken for the shape's.
    const { paths } = patchStrokeOnlyPaths(shape(SOLID, "<a:ln><a:noFill/></a:ln>"));
    expect(paths).toBe(0);
  });

  test("<a:lnTo> path segments are not mistaken for <a:ln> properties", () => {
    // The geometry is full of `<a:lnTo>`; a naive `<a:ln` match would swallow
    // the whole spPr and hide the shape's real fill.
    const { paths } = patchStrokeOnlyPaths(shape(NO_FILL, ""));
    expect(paths).toBe(1);
  });

  test("is idempotent — a second pass adds nothing", () => {
    const once = patchStrokeOnlyPaths(shape(NO_FILL));
    const twice = patchStrokeOnlyPaths(once.xml);
    expect(twice.paths).toBe(0);
    expect(twice.xml).toBe(once.xml);
  });

  test("patches each shape independently in a mixed slide", () => {
    const { xml, paths } = patchStrokeOnlyPaths(shape(NO_FILL) + shape(SOLID) + shape(NO_FILL));
    expect(paths).toBe(2);
    expect((xml.match(/fill="none"/g) ?? []).length).toBe(2);
  });
});

describe("patchPptxStrokeOnlyPaths", () => {
  const slide = (body: string) =>
    `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;

  test("rewrites slide parts and leaves every other part byte-identical", async () => {
    const parts = [
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/slides/slide1.xml", data: slide(shape(NO_FILL)) },
      { name: "ppt/presentation.xml", data: slide(shape(NO_FILL)) },
    ];
    const { bytes, result } = await patchPptxStrokeOnlyPaths(writeZip(parts));
    expect(result).toEqual({ parts: ["ppt/slides/slide1.xml"], paths: 1 });

    const after = await readZipText(bytes);
    expect(after["ppt/slides/slide1.xml"]).toContain('fill="none"');
    // presentation.xml is NOT a slide part: untouched even though it matches.
    expect(after["ppt/presentation.xml"]).not.toContain('fill="none"');
    expect(after["[Content_Types].xml"]).toBe("<Types/>");
  });

  test("returns the ORIGINAL bytes when nothing matches", async () => {
    const original = writeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/slides/slide1.xml", data: slide(shape(SOLID)) },
    ]);
    const { bytes, result } = await patchPptxStrokeOnlyPaths(original);
    expect(result.paths).toBe(0);
    // Identity, not just equality: a deck with nothing to fix is not rewritten.
    expect(bytes).toBe(original);
  });

  test("preserves archive order across the rebuild", async () => {
    const names = ["[Content_Types].xml", "_rels/.rels", "ppt/slides/slide1.xml"];
    const { bytes } = await patchPptxStrokeOnlyPaths(
      writeZip([
        { name: names[0]!, data: "<Types/>" },
        { name: names[1]!, data: "<Relationships/>" },
        { name: names[2]!, data: slide(shape(NO_FILL)) },
      ])
    );
    expect((await readZipEntries(bytes)).map((e) => e.name)).toEqual(names);
  });
});
