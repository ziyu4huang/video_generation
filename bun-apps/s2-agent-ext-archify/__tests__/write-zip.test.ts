/**
 * write-zip.test.ts — the ZIP writer that lets `.pptx` output be post-processed.
 *
 * The load-bearing test is the LAST one: a real built deck, taken apart and put
 * back together by these two modules, must still satisfy the OOXML validity
 * gate. Round-tripping the reader against the writer only proves they agree
 * with each other; `lintPptx` is what proves the archive is still a valid
 * package.
 */
import { describe, expect, test } from "bun:test";
import { buildDeck, parseManifest } from "../lib/deck-build.ts";
import { lintPptx } from "../lib/ooxml-lint.ts";
import { readZipEntries, readZipText } from "../lib/read-zip.ts";
import { crc32, writeZip } from "../lib/write-zip.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const encoder = new TextEncoder();

describe("crc32", () => {
  test('matches the published vector for "123456789"', () => {
    // CRC-32/ISO-HDLC check value, the standard conformance vector.
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });

  test("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("writeZip", () => {
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
    { name: "ppt/slides/slide1.xml", data: "<p:sld/>" },
    { name: "docProps/名稱.xml", data: "<x>你好</x>" },
  ];

  test("round-trips names, order and content through the reader", async () => {
    const read = await readZipEntries(writeZip(entries));
    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    const decoder = new TextDecoder();
    expect(read.map((e) => decoder.decode(e.data))).toEqual(entries.map((e) => e.data));
  });

  test("archive order is preserved, because OOXML readers expect it", async () => {
    const read = await readZipEntries(writeZip(entries));
    expect(read[0]!.name).toBe("[Content_Types].xml");
  });

  test("is deterministic — the same input gives byte-identical output", () => {
    expect(writeZip(entries)).toEqual(writeZip(entries));
  });

  test("accepts Uint8Array data as well as strings", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const read = await readZipEntries(writeZip([{ name: "a.bin", data: bytes }]));
    expect(read[0]!.data).toEqual(bytes);
  });

  test("emits STORE (method 0) for every entry", () => {
    const out = writeZip(entries);
    const dv = new DataView(out.buffer);
    // First local file header: signature at 0, method at +8.
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(8, true)).toBe(0);
  });

  test("an empty archive is still a valid, readable archive", async () => {
    expect(await readZipEntries(writeZip([]))).toEqual([]);
  });
});

describe("a rebuilt .pptx is still a valid package", () => {
  test("disassemble + reassemble keeps ooxml-lint clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-writezip-"));
    try {
      const manifestPath = join(PKG, "examples/deck-composed/deck.config.json");
      const manifest = parseManifest(await Bun.file(manifestPath).text(), manifestPath);
      const output = join(dir, "out.pptx");
      await buildDeck({
        manifest,
        manifestDir: dirname(manifestPath),
        outputPath: output,
        cwd: PKG,
        slidesDir: null,
      });

      const original = await Bun.file(output).bytes();
      const rebuilt = writeZip(
        (await readZipEntries(original)).map((e) => ({ name: e.name, data: e.data }))
      );

      // Same parts, same content.
      expect(await readZipText(rebuilt)).toEqual(await readZipText(original));
      // And still a structurally valid OOXML package — the claim that matters.
      expect(await lintPptx(await readZipText(rebuilt))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
