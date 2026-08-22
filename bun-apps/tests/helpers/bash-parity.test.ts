import { describe, expect, test } from "bun:test";
import { assertParity, normalizeRunOutput, stripAnsi, runScript } from "./bash-parity";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("assertParity", () => {
  test("normalized happy path passes; exit/stdout mismatch throw; errIncludes on raw stderr; pkgName substituted", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-ab-"));
    const script = join(dir, "probe.ts");
    // ANSI + elapsed + inline pkg name on stdout; "boom" on stderr; exit 1
    writeFileSync(script, `console.log("\\x1b[32m✓ s2-agent-ext-btw  \\x1b[2m(12s)\\x1b[0m"); console.error("boom"); process.exit(1);`);
    assertParity(script, [
      { name: "pass", args: [], expectCode: 1, out: "✓ <pkg>  (Ns)", outIs: "normalized", pkgName: "s2-agent-ext-btw", errIncludes: ["boom"] },
    ]);
    expect(() => assertParity(script, [{ name: "x", args: [], expectCode: 0 }])).toThrow(/expected exit 0, got 1/);
    expect(() => assertParity(script, [{ name: "x", args: [], expectCode: 1, out: "nope" }])).toThrow(/stdout mismatch/);
  });
});
