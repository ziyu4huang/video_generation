import { describe, expect, it } from "bun:test";
import { extractSection, parseMapBody } from "../src/markdown.js";

// Characterization of the shared fs-free section parsers (architecture-deepening
// #2 — unified from model.ts's parseMapBody and grill.ts's former strict
// extractSection into one lenient core). parseMapBody was already covered via
// model.ts; extractSection was only tested indirectly via parseDecisions.

describe("extractSection", () => {
  it('returns "" when the section is absent', () => {
    const md = ["# Doc", "", "## Notes", "", "only notes here", ""].join("\n");
    expect(extractSection(md, "Decisions")).toBe("");
  });

  it('tolerates a suffixed heading (## Decisions (draft) → "Decisions")', () => {
    const md = ["## Decisions (draft)", "", "- **Pick**: option A", ""].join("\n");
    expect(extractSection(md, "Decisions")).toBe("- **Pick**: option A");
  });

  it("returns the body up to the next ## heading, trimmed", () => {
    const md = ["# Doc", "", "## Decisions", "", "first line", "second line", "", "## Notes", "", "n", ""].join("\n");
    expect(extractSection(md, "Decisions")).toBe("first line\nsecond line");
  });
});

describe("parseMapBody", () => {
  it('lands heading-less preamble under the "" key', () => {
    const md = ["preamble line", "", "## Notes", "", "notes body", ""].join("\n");
    const s = parseMapBody(md);
    expect(s[""]).toBe("preamble line");
    expect(s.Notes).toBe("notes body");
  });

  it("last section wins on duplicate keys", () => {
    const md = ["## Notes", "", "first", "", "## Notes (more)", "", "second", ""].join("\n");
    // Both headings lenient-key to "Notes"; the later one overwrites.
    const s = parseMapBody(md);
    expect(s.Notes).toBe("second");
  });
});
