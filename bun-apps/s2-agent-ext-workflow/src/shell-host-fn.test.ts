/**
 * Unit tests for shell.run host-fn.
 */

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { shellRunHostFn } from "./shell-host-fn.js";

// Pure arg-validation tests stay ungated (they throw before any spawn).
describe("shell.run host-fn (arg validation)", () => {
  test("rejects non-array cmd", () => {
    expect(() =>
      shellRunHostFn.fn({ cmd: "not an array" }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
    ).toThrow("cmd must be a non-empty array");
  });

  test("rejects empty array cmd", () => {
    expect(() =>
      shellRunHostFn.fn({ cmd: [] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
    ).toThrow("cmd must be a non-empty array");
  });

  test("rejects array with non-string elements", () => {
    expect(() =>
      shellRunHostFn.fn({ cmd: [123] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
    ).toThrow("cmd must be a non-empty array");
  });

  test("rejects missing args object", () => {
    expect(() => shellRunHostFn.fn(null, { cwd: "/", signal: new AbortController().signal, runId: "test" })).toThrow(
      "requires args object",
    );
  });
});

// Spawn-based tests (host-binary probe — portability class P2, see
// .github/TEST-PORTABILITY.md): skipped on CI per the proven skipIf pattern.
// NOTE: the CURRIED skipIf(cond)("name", fn) form — the comma form
// describe.skipIf(cond, fn) silently drops tests under this bun version.
describe("shell.run host-fn (spawn-based)", () => {
  describe.skipIf(Boolean(process.env.CI))("host-binary spawn: skipped on CI (portability P2)", () => {
    test("executes a simple command and returns exitCode/stdout/stderr", () => {
      const result = shellRunHostFn.fn(
        { cmd: ["/bin/echo", "hello world"] },
        { cwd: "/", signal: new AbortController().signal, runId: "test" },
      ) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello world");
      expect(result.stderr).toBe("");
    });

    test("returns non-zero exitCode for failing command", () => {
      const result = shellRunHostFn.fn(
        { cmd: ["false"] },
        { cwd: "/", signal: new AbortController().signal, runId: "test" },
      ) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };

      expect(result.exitCode).not.toBe(0);
    });

    test("truncates output at 20k chars", () => {
      // Generate a large output by printing many lines
      const largeCmd = ["bun", "-e", "console.log('x'.repeat(25000))"];
      const result = shellRunHostFn.fn(
        { cmd: largeCmd },
        { cwd: "/", signal: new AbortController().signal, runId: "test" },
      ) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };

      // Should be truncated
      expect(result.stdout.length).toBeLessThan(25000);
      expect(result.stdout).toContain("[...truncated");
    });

    test("kills a hanging command at the timeout (native spawnSync timeout)", () => {
      const t0 = Date.now();
      const result = shellRunHostFn.fn(
        { cmd: ["bun", "-e", "setTimeout(()=>{},60000)"], timeoutMs: 500 },
        { cwd: "/", signal: new AbortController().signal, runId: "test" },
      ) as { exitCode: number };
      const elapsed = Date.now() - t0;
      expect(result.exitCode).not.toBe(0);
      expect(elapsed).toBeLessThan(5000);
    });

    test("honors ctx.cwd for repo-relative commands", () => {
      const result = shellRunHostFn.fn(
        { cmd: ["bun", "-e", "console.log(process.cwd())"] },
        { cwd: "/tmp", signal: new AbortController().signal, runId: "test" },
      ) as { exitCode: number; stdout: string };
      expect(result.exitCode).toBe(0);
      // macOS resolves /tmp -> /private/tmp, so compare against the realpath.
      expect(result.stdout.trim()).toBe(realpathSync("/tmp"));
    });
  });
});
