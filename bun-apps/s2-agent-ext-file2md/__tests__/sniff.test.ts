/**
 * sniff.test.ts — detectKind matrix: magic bytes always beat the extension.
 */
import { expect, test } from "bun:test";
import JSZip from "jszip";
import { detectKind } from "../src/core/sniff.ts";
import { notebookIpynb, textPdf, tinyPng } from "./helpers/docs.ts";

test("png bytes → image regardless of extension", async () => {
  const r = await detectKind(tinyPng(), "notes.pdf");
  expect(r.kind).toBe("image");
});

test("jpeg/gif/webp/bmp/tiff signatures → image", async () => {
  const cases: Array<[number[], string]> = [
    [[0xff, 0xd8, 0xff, 0xe0], "img"],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "img"],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "img"],
    [[0x42, 0x4d, 0, 0], "img"],
    [[0x49, 0x49, 0x2a, 0x00], "img"],
    [[0x4d, 0x4d, 0x00, 0x2a], "img"],
  ];
  for (const [bytes, name] of cases) {
    const r = await detectKind(new Uint8Array(bytes));
    expect(r.kind).toBe("image");
    void name;
  }
});

test("pdf content wins over a .txt extension", async () => {
  const r = await detectKind(await textPdf(), "paper.txt");
  expect(r.kind).toBe("pdf");
});

test("xlsx/docx/pptx zip families resolve by [Content_Types].xml", async () => {
  const family: Array<[string, string]> = [
    ["xl/", "xlsx"],
    ["word/", "docx"],
    ["ppt/", "pptx"],
  ];
  for (const [dir, expected] of family) {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<Types><Override PartName="/${dir}document.xml"/></Types>`);
    zip.file(dir, "x");
    const r = await detectKind(new Uint8Array(await zip.generateAsync({ type: "uint8array" })));
    expect(r.kind).toBe(expected);
  }
});

test("macro zips are rejected with a stable code", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/vbaProject.bin", "x");
  await expect(detectKind(new Uint8Array(await zip.generateAsync({ type: "uint8array" })))).rejects.toThrow(/macro/i);
});

test("legacy OLE2 compound files are rejected", async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  await expect(detectKind(ole)).rejects.toThrow(/legacy binary/i);
});

test("ipynb by content and by extension hint", async () => {
  const r = await detectKind(notebookIpynb());
  expect(r.kind).toBe("ipynb");
});

test("text family: md/csv/html by extension", async () => {
  const text = new TextEncoder().encode("a,b\n1,2\n");
  expect((await detectKind(text, "t.csv")).kind).toBe("text");
  expect((await detectKind(text, "t.csv")).textKind).toBe("csv");
  const html = new TextEncoder().encode("<html><body>hi</body></html>");
  expect((await detectKind(html, "t.html")).textKind).toBe("html");
  const md = new TextEncoder().encode("# hi\n");
  expect((await detectKind(md, "t.md")).textKind).toBe("md");
});

test("binary garbage with no signature → text fallback (downstream caps it)", async () => {
  const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
  const r = await detectKind(buf, "junk.bin");
  expect(r.kind).toBe("text");
});
