/**
 * convert.test.ts — the pure text-family converters (csv/html) + mode gates
 * of the v2 pipeline (no wasm, no workers).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvToMarkdown, htmlToMarkdown, parseMode, parsePageSpec } from "../src/pipeline.ts";

describe("csvToMarkdown", () => {
  test("builds a table with a header row", () => {
    const md = csvToMarkdown("name,qty\nWidget,3\n");
    expect(md).toBe("| name | qty |\n| --- | --- |\n| Widget | 3 |\n");
  });

  test("round-trips quoted cells with embedded commas and escaped quotes", () => {
    const md = csvToMarkdown('a,b\n"x, y","he said ""hi"""\n');
    expect(md).toContain('| x, y | he said "hi" |');
  });

  test("empty input yields empty output", () => {
    expect(csvToMarkdown("\n\n")).toBe("");
  });
});

describe("htmlToMarkdown", () => {
  test("title + headings + lists + bold + links", () => {
    const md = htmlToMarkdown(
      "<html><head><title>Report</title></head><body><h1>Report</h1><p>Intro <b>bold</b>.</p><ul><li>A</li><li>B</li></ul><a href='https://x'>link</a></body></html>",
    );
    expect(md).toContain("# Report");
    expect(md).toContain("**bold**");
    expect(md).toContain("- A");
    expect(md).toContain("[link](https://x)");
  });

  test("strips script/style and comments", () => {
    const md = htmlToMarkdown("<html><body><script>alert(1)</script><style>x{}</style>hello</body></html>");
    expect(md).toContain("hello");
    expect(md).not.toContain("alert");
  });

  // Golden pin (hardening ticket 04, D7): #2220 fixed two htmlToMarkdown
  // warts (<body> opening a **, closing </hN> emitting a stray #), which
  // changed text-mode output bytes. expected.md pins CURRENT output so the
  // next change is a visible, deliberate diff — regenerate it from
  // input.html with htmlToMarkdown, never hand-edit it.
  test("golden: html-golden/input.html converts byte-equal to expected.md", () => {
    const html = readFileSync(join(import.meta.dir, "fixtures", "html-golden", "input.html"), "utf8");
    const expected = readFileSync(join(import.meta.dir, "fixtures", "html-golden", "expected.md"), "utf8");
    expect(htmlToMarkdown(html)).toBe(expected);
  });
});

describe("parseMode / parsePageSpec (mode gates)", () => {
  test("auto converges on ocr; explicit modes pass through", () => {
    expect(parseMode(undefined)).toBe("ocr");
    expect(parseMode("auto")).toBe("ocr");
    expect(parseMode("text")).toBe("text");
    expect(parseMode("vlm")).toBe("vlm");
  });
  test("bogus mode throws", () => {
    expect(() => parseMode("magic")).toThrow(/Invalid mode/);
  });
  test("page spec expansion", () => {
    expect([...parsePageSpec("1,3-5,8", 10)]).toEqual([1, 3, 4, 5, 8]);
    expect([...parsePageSpec("1-3", 2)]).toEqual([1, 2]); // clamps to pageCount
    expect(parsePageSpec("9", 5).size).toBe(0);
  });
});
