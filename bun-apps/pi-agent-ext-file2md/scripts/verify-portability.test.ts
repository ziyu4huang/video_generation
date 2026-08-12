import { describe, expect, test } from "bun:test";
import { findLeakedHomePaths } from "./verify-portability.ts";

describe("findLeakedHomePaths", () => {
  test("clean code → no warnings", () => {
    expect(findLeakedHomePaths('console.log("hello");')).toEqual([]);
  });

  test("macOS /Users/... leaks", () => {
    const w = findLeakedHomePaths('const p = "/Users/alice/proj/x";');
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/\/Users\//);
  });

  test("Linux /home/... leaks", () => {
    const w = findLeakedHomePaths('const p = "/home/bob/pkg";');
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/\/home\//);
  });

  test("Windows C:\\Users\\ leaks", () => {
    // TS literal `"C:\\Users\\alice"` → actual content `C:\Users\alice`
    const w = findLeakedHomePaths('const p = "C:\\Users\\alice";');
    expect(w.length).toBe(1);
    expect(w[0].includes("C:\\Users")).toBe(true);
  });

  test("exclude exempts intentional embedding", () => {
    const code = 'const p = "/Users/alice/proj/x";';
    // THIN mode intentionally embeds absolute dep paths — exempt via exclude.
    expect(findLeakedHomePaths(code, [/\/Users\/[a-z]/i])).toEqual([]);
  });

  test("does not flag non-home /Users-like subpaths or node: paths", () => {
    expect(findLeakedHomePaths('import "node:fs";')).toEqual([]);
  });
});
