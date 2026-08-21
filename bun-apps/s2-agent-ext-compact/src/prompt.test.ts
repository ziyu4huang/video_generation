import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, buildUserPrompt, extractSummary, SECTION_TITLES } from "./prompt.ts";

const base = {
  conversationText: "user: hello\nassistant: hi",
  fileOps: { read: ["a.ts"], written: [], edited: ["b.ts"] },
  sessionType: "implementation" as const,
  userMessages: [{ index: 1, text: "hello", truncated: false }],
};

describe("SECTION_TITLES", () => {
  test("nine CC sections in order", () => {
    expect(SECTION_TITLES).toEqual([
      "Primary Request and Intent",
      "Key Technical Concepts",
      "Files and Code Sections",
      "Errors and fixes",
      "Problem Solving",
      "All user messages",
      "Pending Tasks",
      "Current Work",
      "Optional Next Step",
    ]);
  });
});

describe("buildUserPrompt", () => {
  test("verified-files above conversation; sections listed; hints present", () => {
    const p = buildUserPrompt(base);
    expect(p.indexOf("<verified-files>")).toBeLessThan(p.indexOf("<conversation>"));
    expect(p).toContain("Edited: b.ts");
    expect(p).toContain("Additional evidence rule");
    expect(p).not.toContain("<previous-summary>");
  });
  test("previousSummary switches to UPDATE variant", () => {
    const p = buildUserPrompt({ ...base, previousSummary: "old summary" });
    expect(p).toContain("<previous-summary>");
    expect(p).toContain("PRESERVE");
  });
  test("customInstructions appended as Additional focus", () => {
    expect(buildUserPrompt({ ...base, customInstructions: "focus on auth" })).toContain(
      "Additional focus: focus on auth",
    );
  });
  test("session-type directive rendered", () => {
    expect(buildUserPrompt(base)).toContain("IMPLEMENTATION");
    expect(buildUserPrompt({ ...base, sessionType: "review" })).toContain("REVIEW");
  });
});

describe("extractSummary", () => {
  test("pulls summary block", () => {
    expect(extractSummary("<analysis>x</analysis>\n<summary>\nbody\n</summary>")).toBe("\nbody\n");
  });
  test("falls back to whole text without tags", () => {
    expect(extractSummary("just text")).toBe("just text");
  });
});
