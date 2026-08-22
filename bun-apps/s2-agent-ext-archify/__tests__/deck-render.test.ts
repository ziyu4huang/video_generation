/**
 * deck-render tests — every assertion here is renderer-free (D1).
 *
 * No test spawns `qlmanage` or `soffice`: a test that skips itself where no
 * backend exists is exactly the dead gate this effort's D1 exists to prevent.
 * What IS pinned is the pure half of the seam — the zip repack, the slide
 * promotion rewrite, the naming contract, and the loud refusal when no backend
 * exists. The rendered evidence lives in the committed receipt, not in CI.
 */
import { describe, expect, test } from "bun:test";
import {
  countSlides,
  crc32,
  defaultRendersDir,
  pickRenderer,
  promoteSlideFirst,
  repackZipEntry,
  rendererStatus,
  slideImageName,
  type RendererId,
} from "../lib/deck-render.ts";
import { DeckError } from "../lib/deck-build.ts";
import { readZipText } from "../lib/read-zip.ts";
import { parseRenderArgs } from "../scripts/deck.ts";

// --- pure zip primitives ----------------------------------------------------

test("crc32 matches the PKZIP check vector", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

/** Independent minimal STORED-zip builder, so the repack test is a round-trip. */
function makeStoredZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // STORED
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // STORED
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Object.keys(files).length, true);
  ev.setUint16(10, Object.keys(files).length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

test("repackZipEntry replaces one entry and leaves the others intact", async () => {
  const src = makeStoredZip({
    "ppt/presentation.xml": "<pres/>",
    "[Content_Types].xml": "<types/>",
    "ppt/slides/slide1.xml": "<s1/>",
  });
  const repacked = repackZipEntry(src, "ppt/presentation.xml", "<promoted/>");
  const parts = await readZipText(repacked);
  expect(parts["ppt/presentation.xml"]).toBe("<promoted/>");
  expect(parts["[Content_Types].xml"]).toBe("<types/>");
  expect(parts["ppt/slides/slide1.xml"]).toBe("<s1/>");
});

test("repackZipEntry adds an entry that was not there", async () => {
  const src = makeStoredZip({ "a.txt": "A" });
  const parts = await readZipText(repackZipEntry(src, "b.txt", "B"));
  expect(parts["a.txt"]).toBe("A");
  expect(parts["b.txt"]).toBe("B");
});

// --- slide promotion --------------------------------------------------------

const PRESENTATION = `<p:presentation><p:sldIdLst>` +
  `<p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/>` +
  `</p:sldIdLst></p:presentation>`;
const RELS = `<Relationships>` +
  `<Relationship Id="rId2" Type="http://…/slide" Target="slides/slide1.xml"/>` +
  `<Relationship Id="rId3" Type="http://…/slide" Target="slides/slide2.xml"/>` +
  `<Relationship Id="rId4" Type="http://…/slide" Target="slides/slide3.xml"/>` +
  `<Relationship Id="rId9" Type="http://…/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
  `</Relationships>`;

test("promoteSlideFirst moves slide 3's sldId to the front, others keep order", () => {
  const out = promoteSlideFirst(PRESENTATION, RELS, 3);
  expect(out.indexOf('r:id="rId4"')).toBeLessThan(out.indexOf('r:id="rId2"'));
  expect(out.indexOf('r:id="rId2"')).toBeLessThan(out.indexOf('r:id="rId3"'));
  // one entry each — promotion must not duplicate
  expect(out.match(/<p:sldId /g)).toHaveLength(3);
});

test("promoteSlideFirst on the already-first slide is a no-op", () => {
  expect(promoteSlideFirst(PRESENTATION, RELS, 1)).toBe(PRESENTATION);
});

test("promoteSlideFirst refuses a slide that does not exist, by name", () => {
  expect(() => promoteSlideFirst(PRESENTATION, RELS, 7)).toThrow(DeckError);
});

test("countSlides counts ppt/slides/slideN.xml parts", () => {
  expect(countSlides({ "ppt/slides/slide1.xml": "a", "ppt/slides/slide2.xml": "b" })).toBe(2);
  expect(countSlides({ "ppt/slides/_rels/slide1.xml.rels": "r" })).toBe(0);
});

// --- the seam's shape -------------------------------------------------------

test("naming contract: slide-N.png and <stem>.renders default dir", () => {
  expect(slideImageName(1)).toBe("slide-1.png");
  expect(defaultRendersDir("/tmp/deck.composed.pptx")).toBe("/tmp/deck.composed.renders");
});

test("pickRenderer is null and names what it looked for when PATH has no backend", () => {
  const saved = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    expect(pickRenderer()).toBeNull();
    const status = rendererStatus();
    expect(status.map((r) => r.id).sort()).toEqual(["libreoffice", "quicklook"] as RendererId[]);
    for (const r of status) {
      expect(r.available).toBe(false);
      expect(r.looksFor.length).toBeGreaterThan(0);
    }
  } finally {
    process.env.PATH = saved;
  }
});

test("rendererStatus reports booleans on a normal PATH too (never throws, never gates)", () => {
  for (const r of rendererStatus()) expect(typeof r.available).toBe("boolean");
});

// --- CLI arg surface --------------------------------------------------------

test("parseRenderArgs takes a config plus --out/--size and passes build flags through", () => {
  const a = parseRenderArgs(["cfg.json", "--out", "imgs", "--size", "800", "--theme", "dark"]);
  expect(a.manifest).toBe("cfg.json");
  expect(a.rendersDir).toBe("imgs");
  expect(a.size).toBe(800);
  expect(a.theme).toBe("dark");
});

test("parseRenderArgs rejects a bad --size and a missing config, with messages", () => {
  expect(() => parseRenderArgs(["cfg.json", "--size", "0"])).toThrow(/--size/);
  expect(() => parseRenderArgs(["--out", "x"])).toThrow(/<config>/);
});
