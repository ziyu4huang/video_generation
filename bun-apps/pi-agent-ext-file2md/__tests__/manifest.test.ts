/**
 * Manifest layout math — pure functions only (no disk I/O).
 *
 *   bun test __tests__/manifest.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createManifest, layoutFor, pageLabel, slugify } from "../src/vlm/manifest.ts";

describe("slugify", () => {
  test("strips the extension, replaces spaces, lowercases", () => {
    expect(slugify("My Doc.pdf")).toBe("my-doc");
    expect(slugify("Already-Good.md")).toBe("already-good");
  });

  test("collapses runs of non-allowed chars into a single hyphen", () => {
    expect(slugify("a   b.c")).toBe("a-b");
  });

  test("falls back to 'doc' when nothing remains", () => {
    expect(slugify("知識管理.md")).toBe("doc"); // all CJK
    expect(slugify("!!!")).toBe("doc"); // only punctuation
  });

  test("preserves allowed punctuation (. _ -) inside the name", () => {
    expect(slugify("v1.2_model.png")).toBe("v1.2_model");
  });
});

describe("pageLabel", () => {
  test("min width is 3", () => {
    expect(pageLabel(1, 5)).toBe("001");
    expect(pageLabel(12, 7)).toBe("012");
  });

  test("width grows with total page count", () => {
    expect(pageLabel(5, 1000)).toBe("0005"); // width 4
    expect(pageLabel(42, 1000)).toBe("0042");
  });

  test("total of exactly 100 still uses width 3", () => {
    expect(pageLabel(1, 100)).toBe("001");
  });
});

describe("layoutFor", () => {
  test("composes dir / pagesDir / manifest / index paths", () => {
    const l = layoutFor("/out", "my-doc", 5);
    expect(l.dir).toBe("/out/my-doc");
    expect(l.pagesDir).toBe("/out/my-doc/pages");
    expect(l.manifestPath).toBe("/out/my-doc/manifest.json");
    expect(l.indexNotePath).toBe("/out/my-doc/my-doc.md");
  });

  test("pngRel/mdRel use the padded page label; pngAbs/mdAbs join dir", () => {
    const l = layoutFor("/out", "my-doc", 5);
    expect(l.pngRel(1)).toBe("pages/page-001.png");
    expect(l.mdRel(1)).toBe("pages/page-001.md");
    expect(l.pngAbs(1)).toBe("/out/my-doc/pages/page-001.png");
    expect(l.mdAbs(1)).toBe("/out/my-doc/pages/page-001.md");
  });
});

describe("createManifest", () => {
  test("builds a pending page per page with schema v1 + equal timestamps", () => {
    const layout = layoutFor("/out", "doc", 3);
    const m = createManifest({
      input: "/in/doc.pdf",
      inputName: "doc.pdf",
      kind: "pdf",
      profile: "paper",
      slug: "doc",
      pageCount: 3,
      layout,
    });
    expect(m.schemaVersion).toBe(1);
    expect(m.input).toBe("/in/doc.pdf");
    expect(m.inputName).toBe("doc.pdf");
    expect(m.kind).toBe("pdf");
    expect(m.profile).toBe("paper");
    expect(m.slug).toBe("doc");
    expect(m.pageCount).toBe(3);
    expect(m.createdAt).toBe(m.updatedAt);
    expect(m.pages.length).toBe(3);
    for (const [i, p] of m.pages.entries()) {
      expect(p.page).toBe(i + 1);
      expect(p.status).toBe("pending");
      expect(p.png).toBe(layout.pngRel(i + 1));
      expect(p.md).toBe(layout.mdRel(i + 1));
    }
  });
});
