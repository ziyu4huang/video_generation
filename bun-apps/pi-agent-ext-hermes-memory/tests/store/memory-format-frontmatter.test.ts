import { describe, test, expect } from "bun:test";
import { serializeMetadataFrontmatter, parseMetadataFrontmatter, detectEntryShape } from "../../src/store/memory-format";

describe("frontmatter format", () => {
  const id = "01846a3e-7c9b-4f2a-9e1d-2b5f8a1c3d47";

  test("minimal entry round-trips with only id/created/last", () => {
    const out = serializeMetadataFrontmatter({ id, text: "hello world", created: "2026-08-01", last: "2026-08-01" });
    expect(out).toBe("---\nid: 01846a3e-7c9b-4f2a-9e1d-2b5f8a1c3d47\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nhello world");
    expect(detectEntryShape(out)).toBe("frontmatter");
    const parsed = parseMetadataFrontmatter(out);
    expect(parsed.id).toBe(id);
    expect(parsed.text).toBe("hello world");
    expect(parsed.created).toBe("2026-08-01");
    expect(parsed.lastReferenced).toBe("2026-08-01");
  });

  test("omits empty optionals; full entry round-trips sources + memworth", () => {
    const out = serializeMetadataFrontmatter({
      id, text: "body", created: "2026-08-01", last: "2026-08-01",
      provenance: "verified",
      sources: [{ kind: "quote", locator: "session:abc", capture: "line with: colon" }],
      mwSuccess: 3, mwFail: 1,
    });
    expect(out).toContain("memworth:\n  success: 3\n  fail: 1");
    expect(out).toContain('capture: "line with: colon"');
    const parsed = parseMetadataFrontmatter(out);
    expect(parsed.provenance).toBe("verified");
    expect(parsed.sources?.[0].capture).toBe("line with: colon");
    expect(parsed.mwSuccess).toBe(3);
    expect(parsed.mwFail).toBe(1);
  });

  test("zero memworth is omitted entirely", () => {
    const out = serializeMetadataFrontmatter({ id, text: "x", created: "2026-08-01", last: "2026-08-01", mwSuccess: 0, mwFail: 0 });
    expect(out).not.toContain("memworth");
  });

  test("detectEntryShape distinguishes comment vs frontmatter", () => {
    expect(detectEntryShape("---\nid: x\n---\nbody")).toBe("frontmatter");
    expect(detectEntryShape("body <!-- created=2026-08-01, last=2026-08-01 -->")).toBe("comment");
  });
});
