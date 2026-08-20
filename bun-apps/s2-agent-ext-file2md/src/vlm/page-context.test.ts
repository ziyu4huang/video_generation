/**
 * page-context.ts — cross-page context accumulator (S1).
 *
 *   bun test src/vlm/page-context.test.ts
 */
import { describe, expect, test } from "bun:test";
import { extractContext, extractTerms, formatContext, PageContext, type PageContextSnapshot } from "./page-context.ts";

const PAGE1 = [
  "---",
  "title: Attention Is All You Need",
  "doc: [[transformer-paper]]",
  "page: 1",
  "kind: paper",
  "section: Abstract",
  "---",
  "",
  "![[page-001.png]]",
  "",
  "## Abstract",
  "We propose the **Transformer** architecture relying on **self-attention**.",
  "",
  "Key idea: drop **recurrence** and use attention.",
].join("\n");

const PAGE2 = [
  "---",
  "title: Attention Is All You Need",
  "doc: [[transformer-paper]]",
  "page: 2",
  "kind: paper",
  "section: Method",
  "---",
  "",
  "![[page-002.png]]",
  "",
  "## Method",
  "The **multi-head attention** combines several attention heads.",
].join("\n");

describe("extractTerms", () => {
  test("harvests headings + bold, deduped, capped", () => {
    const terms = extractTerms("## Intro to **Foo**\n\n**Foo** and **Bar** done", 5);
    // "Intro to Foo" (heading), then Foo (dup), Bar
    expect(terms).toContain("Intro to Foo");
    expect(terms).toContain("Foo");
    expect(terms).toContain("Bar");
    // dedup: Foo appears once
    expect(terms.filter((t) => t === "Foo")).toHaveLength(1);
  });

  test("drops pure-number and too-short tokens", () => {
    const terms = extractTerms("## 42\n\n**a** and **RealTerm**");
    expect(terms).not.toContain("42");
    expect(terms).not.toContain("a");
    expect(terms).toContain("RealTerm");
  });

  test("respects the cap", () => {
    const body = Array.from({ length: 20 }, (_, i) => `## Heading ${i}`).join("\n");
    expect(extractTerms(body, 5).length).toBe(5);
  });
});

describe("extractContext", () => {
  test("pulls title + section from frontmatter, terms from body", () => {
    const c = extractContext(PAGE1);
    expect(c.title).toBe("Attention Is All You Need");
    expect(c.section).toBe("Abstract");
    expect(c.terms).toContain("Abstract");
    expect(c.terms).toContain("Transformer");
    expect(c.terms).toContain("self-attention");
  });

  test("missing frontmatter → no title/section, body terms still extracted", () => {
    const c = extractContext("no fm here\n\n## Just a **Term**");
    expect(c.title).toBeUndefined();
    expect(c.section).toBeUndefined();
    expect(c.terms).toContain("Just a Term");
  });
});

describe("PageContext accumulator", () => {
  test("empty until fed", () => {
    const ctx = new PageContext();
    expect(ctx.empty).toBe(true);
    expect(ctx.snapshot()).toEqual({ title: undefined, section: undefined, terms: [] });
  });

  test("page 1 gets empty context (snapshot before any feed)", () => {
    const ctx = new PageContext();
    // simulate: read snapshot BEFORE feeding page 1 → empty
    expect(ctx.empty).toBe(true);
    ctx.feed(PAGE1);
    // now snapshot has page 1's context, for page 2
    const after1 = ctx.snapshot();
    expect(after1.title).toBe("Attention Is All You Need");
    expect(after1.section).toBe("Abstract");
    expect(after1.terms.length).toBeGreaterThan(0);
  });

  test("running section updates to the latest page", () => {
    const ctx = new PageContext();
    ctx.feed(PAGE1);
    ctx.feed(PAGE2);
    expect(ctx.snapshot().section).toBe("Method"); // latest, not Abstract
  });

  test("title stays stable (kept from page 1)", () => {
    const ctx = new PageContext();
    ctx.feed(PAGE1);
    ctx.feed(PAGE2); // same title anyway
    expect(ctx.snapshot().title).toBe("Attention Is All You Need");
  });

  test("terms merge across pages and dedup", () => {
    const ctx = new PageContext();
    ctx.feed(PAGE1);
    const after1Terms = new Set(ctx.snapshot().terms);
    ctx.feed(PAGE2);
    const after2 = ctx.snapshot().terms;
    // new term from page 2 present
    expect(after2).toContain("multi-head attention");
    // page-1 terms still present (Transformer etc.)
    for (const t of after1Terms) expect(after2).toContain(t);
    // no duplicates (case-insensitive)
    const lower = after2.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  test("snapshot returns a copy (mutating it does not affect the accumulator)", () => {
    const ctx = new PageContext();
    ctx.feed(PAGE1);
    const snap = ctx.snapshot();
    snap.terms.push("HACKED");
    expect(ctx.snapshot().terms).not.toContain("HACKED");
  });
});

describe("formatContext", () => {
  test("undefined when empty (page 1 / single-image)", () => {
    expect(formatContext({ title: undefined, section: undefined, terms: [] })).toBeUndefined();
  });

  test("renders a compact 繁中 preamble with title / section / terms", () => {
    const snap: PageContextSnapshot = {
      title: "My Doc",
      section: "Method",
      terms: ["Transformer", "self-attention"],
    };
    const out = formatContext(snap)!;
    expect(out.startsWith("前文脈絡")).toBe(true);
    expect(out).toContain("標題=My Doc");
    expect(out).toContain("目前章節=Method");
    expect(out).toContain("已知術語=Transformer、self-attention");
  });

  test("omits absent fields", () => {
    const out = formatContext({ title: "T", section: undefined, terms: [] })!;
    expect(out).toContain("標題=T");
    expect(out).not.toContain("章節");
    expect(out).not.toContain("術語");
  });
});
