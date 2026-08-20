/**
 * Tests for the environment sidecar.
 *
 * The load-bearing property is that a write failure NEVER propagates: a diagnostic
 * tool must not break the session it is diagnosing.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSidecarRecord, readSidecar, writeSidecar } from "../sidecar.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sidecar-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildSidecarRecord", () => {
  test("fingerprints the tool list order-independently", () => {
    const a = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["b", "a"] });
    const b = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a", "b"] });
    expect(a.toolFingerprint).toBe(b.toolFingerprint);
    expect(a.toolCount).toBe(2);
  });

  test("changes the fingerprint when a tool is added", () => {
    const a = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a"] });
    const b = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a", "c"] });
    expect(a.toolFingerprint).not.toBe(b.toolFingerprint);
  });

  test("stores no derived metric — environment facts only", () => {
    const r = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: [] });
    expect(Object.keys(r).sort()).toEqual(
      ["cwd", "gitSha", "sessionId", "toolCount", "toolFingerprint", "ts"].sort(),
    );
  });
});

describe("writeSidecar", () => {
  test("appends one JSON line per call", () => {
    const file = join(tmp(), "env.jsonl");
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/r", ts: 1, toolNames: [] }));
    writeSidecar(file, buildSidecarRecord({ sessionId: "b", cwd: "/r", ts: 2, toolNames: [] }));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).sessionId).toBe("b");
  });

  test("swallows a write failure instead of throwing", () => {
    const unwritable = join(tmp(), "nope", "deep", "env.jsonl");
    expect(() =>
      writeSidecar(
        unwritable,
        buildSidecarRecord({ sessionId: "a", cwd: "/r", ts: 1, toolNames: [] }),
        { mkdir: false },
      ),
    ).not.toThrow();
  });
});

describe("readSidecar", () => {
  test("returns an empty map for a missing file", () => {
    expect(readSidecar(join(tmp(), "absent.jsonl")).size).toBe(0);
  });

  test("indexes records by sessionId, last write winning", () => {
    const file = join(tmp(), "env.jsonl");
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/one", ts: 1, toolNames: [] }));
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/two", ts: 2, toolNames: [] }));
    expect(readSidecar(file).get("a")!.cwd).toBe("/two");
  });

  test("skips malformed lines", () => {
    const file = join(tmp(), "env.jsonl");
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/r", ts: 1, toolNames: [] }));
    require("node:fs").appendFileSync(file, "{broken\n", "utf8");
    expect(readSidecar(file).size).toBe(1);
  });
});
