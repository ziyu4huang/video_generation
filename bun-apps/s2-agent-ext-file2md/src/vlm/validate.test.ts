/**
 * validate.ts — output quality gate.
 *
 *   bun test src/vlm/validate.test.ts
 */
import { describe, expect, test } from "bun:test";
import { validatePageMarkdown } from "./validate.ts";

/** A minimal valid page note (passes every check). */
const GOOD = [
  "---",
  "title: Some Page",
  "doc: [[my-doc]]",
  "page: 1",
  "kind: paper",
  "section: Method",
  "---",
  "",
  "![[page-001.png]]",
  "",
  "This page describes the proposed method in enough detail to clear the floor.",
].join("\n");

describe("validatePageMarkdown — pass", () => {
  test("well-formed page note passes", () => {
    const r = validatePageMarkdown(GOOD, { page: 1, kind: "paper" });
    expect(r).toEqual({ ok: true });
  });

  test("passes with CRLF line endings", () => {
    const r = validatePageMarkdown(GOOD.replace(/\n/g, "\r\n"), { page: 1, kind: "paper" });
    expect(r.ok).toBe(true);
  });

  test("extra frontmatter keys and a long body are fine", () => {
    const md = GOOD.replace("clear the floor.", `clear the floor. ${"x".repeat(500)}`);
    expect(validatePageMarkdown(md, { page: 1, kind: "paper" }).ok).toBe(true);
  });

  test("custom minBodyChars=0 accepts a one-word body", () => {
    const md = GOOD.replace("This page describes the proposed method in enough detail to clear the floor.", "word");
    expect(validatePageMarkdown(md, { page: 1, kind: "paper", minBodyChars: 0 }).ok).toBe(true);
  });
});

describe("validatePageMarkdown — fail", () => {
  test("empty output", () => {
    const r = validatePageMarkdown("   ", { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/empty/i);
  });

  test("missing opening frontmatter delimiter", () => {
    const md = GOOD.replace(/^---\n/, "preamble\n---\n");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/opening/);
  });

  test("unclosed frontmatter (no closing ---)", () => {
    // Drop the closing delimiter only: keep keys, then straight into body.
    const lines = GOOD.split("\n");
    // remove the second "---" (index of closing delim)
    const closeIdx = lines.indexOf("---", 1);
    const md = [...lines.slice(0, closeIdx), ...lines.slice(closeIdx + 1)].join("\n");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/unclosed|closing/);
  });

  test("empty frontmatter (delimiters back-to-back)", () => {
    const md = "---\n---\n\n![[page-001.png]]\n\nbody content long enough";
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/empty frontmatter/);
  });

  test("missing required key (no kind)", () => {
    const md = GOOD.replace("kind: paper\n", "");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/missing required key: kind/);
  });

  test("missing required key (no page)", () => {
    const md = GOOD.replace("page: 1\n", "");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/missing required key: page/);
  });

  test("missing image embed", () => {
    const md = GOOD.replace("![[page-001.png]]\n\n", "");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/embed/);
  });

  test("body below the default floor (20 chars)", () => {
    const md = GOOD.replace(
      "This page describes the proposed method in enough detail to clear the floor.",
      "short", // 5 chars < 20
    );
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/body too short/i);
  });

  test("embed-only body (no prose) fails the floor", () => {
    const md = [
      "---",
      "title: T",
      "page: 1",
      "kind: paper",
      "---",
      "",
      "![[page-001.png]]",
      "", // no body prose at all
    ].join("\n");
    const r = validatePageMarkdown(md, { page: 1, kind: "paper" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/body too short/i);
  });
});
