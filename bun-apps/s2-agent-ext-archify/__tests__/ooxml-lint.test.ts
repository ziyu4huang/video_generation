import { describe, expect, test } from "bun:test";
import { formatDiagnostics, lintPptx, type OoxmlDiagnostic } from "../lib/ooxml-lint.ts";

/** A minimal but VALID package, so each test breaks exactly one thing. */
function pkg(over: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      "</Types>",
    "_rels/.rels": '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="ppt/x"/></Relationships>',
    "ppt/slides/_rels/slide1.xml.rels":
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="../slideLayouts/l.xml"/></Relationships>',
    "ppt/slides/slide1.xml": slide(),
  };
  return { ...base, ...over };
}

function slide(inner = shape()): string {
  return `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
}

function shape(
  spPr = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill/><a:ln w="12700"/>'
): string {
  return `<p:sp><p:spPr>${spPr}</p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>hi</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function codes(diags: OoxmlDiagnostic[]): string[] {
  return diags.map((d) => d.code);
}

test("a well-formed package produces no diagnostics", async () => {
  expect(await lintPptx(pkg())).toEqual([]);
});

describe("rule 1 — package inventory", () => {
  test("a part with neither a Default nor an Override is reported", async () => {
    const diags = await lintPptx(pkg({ "ppt/media/image1.png": "" }));
    expect(codes(diags)).toContain("content-type-missing");
    expect(diags[0]!.part).toBe("ppt/media/image1.png");
  });

  test("a directory entry is not a part", async () => {
    // ZIPs carry directory entries; they are absent from [Content_Types].xml by
    // design, so reporting them would be 19 false positives on a real deck.
    expect(await lintPptx(pkg({ "ppt/slides/": "" }))).toEqual([]);
  });

  test("a package with no [Content_Types].xml is reported once", async () => {
    const parts = pkg();
    delete parts["[Content_Types].xml"];
    expect(codes(await lintPptx(parts))).toEqual(["content-type-missing"]);
  });
});

describe("rule 2 — relationship ids resolve", () => {
  test("an r:id absent from the sibling .rels is reported", async () => {
    const diags = await lintPptx(
      pkg({ "ppt/slides/slide1.xml": slide(`<p:sp><a:blip r:embed="rId99"/></p:sp>`) })
    );
    expect(codes(diags)).toContain("rel-unresolved");
    expect(diags[0]!.message).toContain("rId99");
  });

  test("an r:id present in the sibling .rels is accepted", async () => {
    const diags = await lintPptx(
      pkg({ "ppt/slides/slide1.xml": slide(`<p:sp><a:blip r:embed="rId1"/></p:sp>`) })
    );
    expect(codes(diags)).not.toContain("rel-unresolved");
  });
});

describe("rule 3 — EMU coordinates", () => {
  test("a non-integer extent is reported", async () => {
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape('<a:xfrm><a:off x="0" y="0"/><a:ext cx="914400.5" cy="1"/></a:xfrm>')
        ),
      })
    );
    expect(codes(diags)).toContain("emu-invalid");
  });

  test("a negative extent is reported, a negative offset is not", async () => {
    const neg = (xfrm: string) =>
      lintPptx(pkg({ "ppt/slides/slide1.xml": slide(shape(xfrm)) })).then(codes);
    expect(await neg('<a:xfrm><a:off x="0" y="0"/><a:ext cx="-1" cy="1"/></a:xfrm>')).toContain(
      "emu-invalid"
    );
    // A shape legitimately sits at a negative offset when it bleeds off-stage.
    expect(await neg('<a:xfrm><a:off x="-914400" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>')).not.toContain(
      "emu-invalid"
    );
  });

  test("a coordinate past the ST_Coordinate range is reported", async () => {
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape('<a:xfrm><a:off x="99999999999999" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>')
        ),
      })
    );
    expect(codes(diags)).toContain("emu-invalid");
  });

  test("<a:ext> under <a:extLst> is a DIFFERENT element and is left alone", async () => {
    // CT_OfficeArtExtension carries a uri, not cx/cy. Checking it without
    // looking at the parent reports every real theme part as broken.
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape(
            '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>' +
              '<a:extLst><a:ext uri="{FF2B5EF4}"/></a:extLst>'
          )
        ),
      })
    );
    expect(codes(diags)).not.toContain("emu-invalid");
  });
});

describe("rules 4 and 5 — DrawingML child sequences", () => {
  test("a fill before the geometry is out of CT_ShapeProperties sequence", async () => {
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape(
            '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:solidFill/><a:prstGeom prst="rect"/>'
          )
        ),
      })
    );
    expect(codes(diags)).toContain("sppr-order");
  });

  test("pathLst before rect is out of CT_CustomGeometry2D sequence", async () => {
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape(
            "<a:custGeom><a:avLst/><a:pathLst><a:path w=\"1\" h=\"1\"><a:moveTo><a:pt x='0' y='0'/></a:moveTo></a:path></a:pathLst><a:rect l='l' t='t' r='r' b='b'/></a:custGeom>"
          )
        ),
      })
    );
    expect(codes(diags)).toContain("custgeom-order");
  });

  test("the sequence the emitter actually produces is accepted", async () => {
    const diags = await lintPptx(
      pkg({
        "ppt/slides/slide1.xml": slide(
          shape(
            '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>' +
              "<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l='l' t='t' r='r' b='b'/>" +
              "<a:pathLst><a:path w=\"1\" h=\"1\"><a:moveTo><a:pt x='0' y='0'/></a:moveTo></a:path></a:pathLst></a:custGeom>" +
              '<a:ln w="12700"/>'
          )
        ),
      })
    );
    expect(diags).toEqual([]);
  });
});

describe("rule 6 — font size range", () => {
  test.each([["50"], ["500000"], ["17.5"]])("sz=%s is out of ST_TextFontSize", async (sz) => {
    const xml = slide(
      `<p:sp><p:txBody><a:p><a:r><a:rPr sz="${sz}"/><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`
    );
    expect(codes(await lintPptx(pkg({ "ppt/slides/slide1.xml": xml })))).toContain(
      "font-size-range"
    );
  });

  test("a 5.9 pt diagram label (sz=590) is legal", async () => {
    // Small type is exactly what a dense architecture diagram produces; the
    // floor is 1 pt, not something more comfortable.
    const xml = slide(
      '<p:sp><p:txBody><a:p><a:r><a:rPr sz="590"/><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'
    );
    expect(codes(await lintPptx(pkg({ "ppt/slides/slide1.xml": xml })))).not.toContain(
      "font-size-range"
    );
  });
});

describe("rule 7 — a path opens with moveTo", () => {
  const path = (inner: string) =>
    slide(shape(`<a:custGeom><a:pathLst><a:path w="10" h="10">${inner}</a:path></a:pathLst></a:custGeom>`));

  test("a path starting with lnTo is reported", async () => {
    const diags = await lintPptx(
      pkg({ "ppt/slides/slide1.xml": path("<a:lnTo><a:pt x='1' y='1'/></a:lnTo>") })
    );
    expect(codes(diags)).toContain("path-no-moveto");
  });

  test("an interleaved segment list is judged on DOCUMENT order", async () => {
    // The case that decides the parser: `lnTo` appears twice with a `quadBezTo`
    // between them. Bun.XML merges the two `lnTo`s into one array and loses the
    // interleaving; HTMLRewriter streams, so order is structural.
    const inner =
      "<a:moveTo><a:pt x='0' y='0'/></a:moveTo>" +
      "<a:lnTo><a:pt x='1' y='0'/></a:lnTo>" +
      "<a:quadBezTo><a:pt x='2' y='0'/><a:pt x='2' y='1'/></a:quadBezTo>" +
      "<a:lnTo><a:pt x='2' y='9'/></a:lnTo>";
    expect(codes(await lintPptx(pkg({ "ppt/slides/slide1.xml": path(inner) })))).not.toContain(
      "path-no-moveto"
    );
  });
});

describe("Bun.XML behaviour receipt (bun 1.4.0)", () => {
  const XML = (Bun as unknown as { XML: { parse(s: string, o?: unknown): Record<string, unknown> } })
    .XML;

  test("order across DISTINCT sibling tags survives — this is what rules 4-5 rely on", () => {
    const doc = XML.parse(
      '<a:spPr><a:xfrm/><a:custGeom/><a:ln/></a:spPr>'
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(doc["a:spPr"]!)).toEqual(["a:xfrm", "a:custGeom", "a:ln"]);
  });

  test("order across REPEATED sibling tags is lost — this is why rule 7 streams", () => {
    const doc = XML.parse(
      "<a:path><a:moveTo/><a:lnTo id='1'/><a:quadBezTo/><a:lnTo id='2'/></a:path>"
    ) as Record<string, Record<string, unknown>>;
    // The 4th child has been folded into the 2nd child's array, so `quadBezTo`
    // — document position 3 — now reads as coming after BOTH `lnTo`s.
    expect(Object.keys(doc["a:path"]!)).toEqual(["a:moveTo", "a:lnTo", "a:quadBezTo"]);
    expect(doc["a:path"]!["a:lnTo"]).toHaveLength(2);
  });

  test("every preserveOrder-style option is a silently accepted no-op", () => {
    // Pinned so a future bun that implements one is noticed rather than assumed.
    for (const key of ["preserveOrder", "alwaysArray", "order", "keepOrder"]) {
      const doc = XML.parse("<r><a/><b/><a/></r>", { [key]: true }) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(doc["r"]!), key).toEqual(["a", "b"]);
    }
  });
});

test("formatDiagnostics prints one actionable line per finding", async () => {
  const diags = await lintPptx(pkg({ "ppt/media/image1.png": "" }));
  expect(formatDiagnostics(diags)).toBe(
    '[content-type-missing] ppt/media/image1.png: no Default for ".png" and no Override for "/ppt/media/image1.png" in [Content_Types].xml'
  );
});
