import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFile2mdEmission, emitFile2mdKnowledge } from "../extensions/file2md.ts";

describe("buildFile2mdEmission", () => {
  test("produces the file2md knowledge payload shape", () => {
    const p = buildFile2mdEmission("my-doc", "/abs/vlm-out/my-doc");
    expect(p).toEqual({
      source: "generic",
      sourceLabel: "file2md:my-doc",
      dir: "/abs/vlm-out/my-doc",
    });
  });
});

describe("emitFile2mdKnowledge", () => {
  test("fires pi.events.emit on the pi:knowledge channel", () => {
    let called: { channel: string; data: unknown } | null = null;
    const pi = { events: { emit: (c: string, d: unknown) => (called = { channel: c, data: d }) } } as never;
    emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"));
    expect(called).not.toBeNull();
    const c = called as { channel: string; data: unknown };
    expect(c.channel).toBe("pi:knowledge");
    expect((c.data as { dir: string }).dir).toBe("/x");
  });

  test("missing events bus → no-op, no throw", () => {
    const pi = { events: undefined } as never;
    expect(() => emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"))).not.toThrow();
  });

  test("throwing emit → swallowed, no throw", () => {
    const pi = {
      events: {
        emit: () => {
          throw new Error("boom");
        },
      },
    } as never;
    expect(() => emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"))).not.toThrow();
  });
});

describe("tier rule — no upward hub import", () => {
  test("file2md extension does not import knowledge-card", () => {
    const src = readFileSync(join(__dirname, "..", "extensions", "file2md.ts"), "utf8");
    expect(src).not.toContain("s2-agent-ext-knowledge-card");
  });
});
