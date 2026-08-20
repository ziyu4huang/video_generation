/**
 * jsonl-mirror.test.ts — webui-simplify §4 (PR4): the ONE shared JSONL
 * persistence pattern. Both per-port mirrors (report-persist, btw-store)
 * previously carried identical best-effort fs code; these tests pin the
 * shared helper's contract: mkdir-on-append, tolerant read (blank lines
 * skipped, corrupt lines preserved verbatim), order-preserving rewrite.
 * Behavior freeze: the report + btw suites must pass UNMODIFIED on top.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, readLines, rewriteLines } from "../src/jsonl-mirror.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "jsonl-"));
}

describe("jsonl-mirror", () => {
  test("appendLine creates nested dirs + round-trips through readLines", () => {
    const p = join(tmp(), "deep", "f.jsonl");
    appendLine(p, { a: 1 });
    appendLine(p, { b: "x" });
    const lines = readLines(p);
    expect(lines).toEqual(['{"a":1}', '{"b":"x"}']);
    expect(JSON.parse(lines[1]!)).toEqual({ b: "x" });
  });

  test("readLines: missing file -> [], blank lines skipped, corrupt lines kept verbatim", () => {
    expect(readLines(join(tmp(), "none.jsonl"))).toEqual([]);
    const p = join(tmp(), "corrupt.jsonl");
    writeFileSync(p, '{"ok":1}\n\n   \nNOT JSON\n{"ok":2}\n', "utf8");
    expect(readLines(p)).toEqual(['{"ok":1}', "NOT JSON", '{"ok":2}']);
  });

  test("rewriteLines keeps order + corrupt lines with one trailing newline; [] truncates", () => {
    const p = join(tmp(), "rw.jsonl");
    appendLine(p, { n: 1 });
    appendLine(p, { n: 2 });
    rewriteLines(p, ['{"n":1}', "CORRUPT"]);
    expect(readLines(p)).toEqual(['{"n":1}', "CORRUPT"]);
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\nCORRUPT\n');
    rewriteLines(p, []);
    expect(readFileSync(p, "utf8")).toBe("");
  });
});
