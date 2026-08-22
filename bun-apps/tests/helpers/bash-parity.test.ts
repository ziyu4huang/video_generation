import { describe, expect, test } from "bun:test";
import { normalizeRunOutput, stripAnsi, runScript } from "./bash-parity";

describe("normalizeRunOutput", () => {
  test("strips ANSI, elapsed timings, tmp log paths, and package name", () => {
    const in_ = "\x1b[32m✓ quick  \x1b[2m(12s)\x1b[0m\x1b[33m▶ s2-agent-ext-btw run-test.sh — tier=quick\x1b[0m";
    const out = normalizeRunOutput(in_, "s2-agent-ext-btw");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("✓ quick");
    expect(out).not.toContain("(12s)");
    expect(out).toContain("tier=quick");
  });
  test("normalizes /tmp logs", () => {
    expect(normalizeRunOutput("log: /tmp/s2-agent-ext-btw-runtest.log")).toContain("/tmp/<log>");
  });
  test("stripAnsi only strips the escape", () => {
    expect(stripAnsi("a\x1b[31mb\x1b[0mc")).toBe("abc");
  });
});

describe("runScript", () => {
  test("returns child stdout/stderr/code; child exit 1 is not a throw", () => {
    const r = runScript("bun", "-e", ["console.error('boom'); process.exit(1)"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom");
  });
});
