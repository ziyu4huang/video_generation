/**
 * Pure unit tests for snapshot-compress.ts — the Playwright-free text
 * transforms behind the browser tool's snapshot pipeline. Fixtures mirror
 * ariaSnapshot({mode:"ai"}) output; assertions adapted from the BetterWright
 * reference suite (tests/node/snapshot.test.ts, MIT).
 */
import { describe, expect, test } from "bun:test";
import {
  CONTENT_HEAVY_HINT,
  actModeHint,
  compressSnapshot,
  diffSnapshots,
  filterInteractive,
  filterReadable,
} from "../snapshot-compress.js";

const TREE = [
  "- generic [active] [ref=e1]:",
  '  - navigation [ref=e2]:',
  '    - link "Home" [ref=e3] [cursor=pointer]:',
  '      - /url: "#a"',
  '  - main [ref=e5]:',
  '    - heading "Title" [level=1] [ref=e6]',
  "    - paragraph [ref=e7]: Static text.",
  "    - generic [ref=e8]:",
  '      - textbox "Email" [ref=e9]',
  '      - button "Submit" [ref=e10]',
].join("\n");

describe("filterInteractive (pruneMode 'act')", () => {
  test("prunes static text, keeps buttons/links + ancestors", () => {
    const filtered = filterInteractive(TREE);
    expect(filtered).toContain('link "Home"');
    expect(filtered).toContain('link "Home" [ref=e3]');
    expect(filtered).toContain("- /url: \"#a\"");
    expect(filtered).toContain('textbox "Email"');
    expect(filtered).toContain('button "Submit"');
    // Ancestors survive so the tree stays readable.
    expect(filtered).toContain("navigation [ref=e2]");
    expect(filtered).toContain("main [ref=e5]");
    // Non-interactive content is dropped.
    expect(filtered).not.toContain("heading");
    expect(filtered).not.toContain("Static text.");
  });

  test("reports pages with nothing to click", () => {
    expect(filterInteractive('- heading "Only text" [ref=e1]')).toBe(
      "(no interactive elements)",
    );
  });
});

describe("filterReadable (pruneMode 'read')", () => {
  test("keeps paragraphs, headings, and links (navigation stays possible)", () => {
    const readable = filterReadable(TREE);
    expect(readable).toContain('heading "Title"');
    expect(readable).toContain("Static text.");
    expect(readable).toContain('link "Home"');
    expect(readable).toContain("paragraph [ref=e7]: Static text.");
    // Interactive elements are kept alongside content so the agent can act.
    expect(readable).toContain('button "Submit"');
  });

  test("reports pages with no readable content", () => {
    expect(filterReadable("- separator [ref=e1]")).toBe("(no readable content)");
  });
});

describe("actModeHint (D7)", () => {
  test("returns the content-heavy hint when act output collapses below ~5 lines", () => {
    expect(actModeHint('- button "A" [ref=e1]')).toBe(CONTENT_HEAVY_HINT);
    expect(actModeHint("- link \"A\" [ref=e1]\n- link \"B\" [ref=e2]")).toBe(CONTENT_HEAVY_HINT);
  });

  test("returns null for empty output or a healthy act snapshot", () => {
    expect(actModeHint("")).toBeNull();
    // A full act prune of TREE keeps 8 lines (ancestors + link/url/textbox/
    // button) — above the ~5-line collapse threshold.
    expect(actModeHint(filterInteractive(TREE))).toBeNull();
    const healthy = Array.from({ length: 6 }, (_, i) => `- button "b${i}" [ref=e${i}]`).join(
      "\n",
    );
    expect(actModeHint(healthy)).toBeNull();
  });
});

describe("compressSnapshot", () => {
  test("prunes /url lines by default and keeps them on request", () => {
    const tree = ['- link "Docs" [ref=e2] [cursor=pointer]:', "  - /url: /docs"].join("\n");
    expect(compressSnapshot(tree)).toBe('- link "Docs" [ref=e2]');
    expect(compressSnapshot(tree, { urls: true })).toBe(
      ['- link "Docs" [ref=e2]:', "  - /url: /docs"].join("\n"),
    );
  });

  test("truncates names over 100 characters", () => {
    const longName = "x".repeat(150);
    const compressed = compressSnapshot(`- button "${longName}" [ref=e2]`);
    expect(compressed).toContain(`"${"x".repeat(99)}…"`);
    expect(compressed).not.toContain(longName);
  });
});

describe("diffSnapshots", () => {
  test("detects no change", () => {
    expect(diffSnapshots(TREE, TREE)).toEqual({ changed: false });
  });

  test("returns only the minimal changed region", () => {
    const after = TREE.replace(
      '      - button "Submit" [ref=e10]',
      '      - button "Sending…" [disabled] [ref=e10]\n      - alert [ref=e11]: Sent!',
    );
    const result = diffSnapshots(TREE, after);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.removals).toBe(1);
    const lines = (result.diff ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines).toContain('-       - button "Submit" [ref=e10]');
    expect(lines).toContain('+       - button "Sending…" [disabled] [ref=e10]');
  });
});
