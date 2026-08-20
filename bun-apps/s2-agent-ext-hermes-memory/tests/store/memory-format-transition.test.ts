import { describe, test, expect } from "bun:test";
import { upgradeEntryToFrontmatter, parseMarkdownMemoryEntry, detectEntryShape } from "../../src/store/memory-format";

describe("dual-shape transition", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  test("upgrade rewrites a comment entry to frontmatter with id, preserving failure fields", () => {
    const legacy = "[failure] boom — Failed: timeout <!-- created=2026-07-30, last=2026-07-31 -->";
    const out = upgradeEntryToFrontmatter(legacy, "failure", null, id);
    expect(detectEntryShape(out)).toBe("frontmatter");
    expect(out).toContain(`id: ${id}`);
    expect(out).toContain("created: 2026-07-30");
    expect(out).toContain("last: 2026-07-31");   // renamed
    // body intact — failure parsing still works on the upgraded entry
    const reparsed = parseMarkdownMemoryEntry(out, "failure", null);
    expect(reparsed.category).toBe("failure");
    expect(reparsed.failureReason).toBe("timeout");
    // C1-v2: the stable id surfaces on the declared `mdId` field (the unified
    // decode reads the frontmatter id via typeof-string), not the old leaked
    // `.id` produced by spreading parseMetadataFrontmatter's full envelope.
    expect(reparsed.mdId).toBe(id);
  });

  test("parseMarkdownMemoryEntry handles both shapes", () => {
    const legacy = "note <!-- created=2026-08-01, last=2026-08-01 -->";
    expect(parseMarkdownMemoryEntry(legacy, "memory", null).content).toBe("note");
    const fm = "---\nid: x\ncreated: 2026-08-01\nlast: 2026-08-01\n---\nnote";
    const parsed = parseMarkdownMemoryEntry(fm, "memory", null);
    expect(parsed.content).toBe("note");
    // C1-v2: the stable id surfaces on the declared `mdId` field.
    expect(parsed.mdId).toBe("x");
  });
});
