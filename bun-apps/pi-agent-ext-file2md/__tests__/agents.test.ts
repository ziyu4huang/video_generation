/**
 * Pure helpers in src/vlm/agents.ts.
 *
 * These are the format-fixers that run on every VLM page reply BEFORE it is
 * written to disk: systemPromptFor (profile → prompt), normalizeEmbeds
 * (angle-bracket embed repair), normalizeFrontmatter (close + override the
 * CLI-known page/kind fields), pageUserMessage, and readImageContent.
 *
 * No model session / network is created — all pure.
 *
 *   bun test __tests__/agents.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeEmbeds,
  normalizeFrontmatter,
  pageUserMessage,
  readImageContent,
  systemPromptFor,
} from "../src/vlm/agents.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-agents-"));
  await writeFile(join(dir, "page.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("systemPromptFor", () => {
  test("each profile yields a prompt tagged with its own kind code", () => {
    for (const p of ["paper", "slides", "poster", "diagram", "image"] as const) {
      const s = systemPromptFor(p);
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
      // The kind code appears verbatim in the prompt's "kind 欄位固定為 <code>" rule.
      expect(s.includes(`kind 欄位固定為 ${p}`)).toBe(true);
    }
  });

  test("S3: every profile prompt carries the few-shot format example", () => {
    for (const p of ["paper", "slides", "poster", "diagram", "image"] as const) {
      const s = systemPromptFor(p);
      // The shared example shows a CLOSED frontmatter + a bracket-free embed —
      // the two recurring model defects normalize* otherwise repairs.
      expect(s.includes("格式範例")).toBe(true);
      expect(s.includes("![[page-001.png]]")).toBe(true);
      expect(s.includes("第二個 --- 關閉")).toBe(true);
    }
  });

  test("unknown profile falls back to the image prompt", () => {
    expect(systemPromptFor("bogus" as any)).toBe(systemPromptFor("image"));
  });

  test("paper prompt is distinct from the image prompt", () => {
    expect(systemPromptFor("paper")).not.toBe(systemPromptFor("image"));
  });

  test("T3: lang/mode reach the prompt (default zh-TW/hybrid vs override)", () => {
    const def = systemPromptFor("paper");
    expect(def.includes("繁體中文")).toBe(true); // default lang
    expect(def.includes("整理與摘要")).toBe(true); // default mode
    const en = systemPromptFor("paper", { lang: "en", mode: "verbatim" });
    expect(en.includes("English")).toBe(true);
    expect(en.includes("忠實謄寫")).toBe(true);
    expect(en.includes("繁體中文")).toBe(false); // overridden away
    const sum = systemPromptFor("image", { mode: "summary" });
    expect(sum.includes("摘要整理")).toBe(true);
  });
});

describe("normalizeEmbeds", () => {
  test("strips stray angle brackets the VLM wraps around the embed filename", () => {
    expect(normalizeEmbeds("![[<page-003.png>]]")).toBe("![[page-003.png]]");
  });

  test("trims surrounding spaces inside the embed", () => {
    expect(normalizeEmbeds("![[ <page-003.png> ]]")).toBe("![[page-003.png]]");
  });

  test("leaves a valid embed untouched", () => {
    const ok = "![[page-001.png]]";
    expect(normalizeEmbeds(ok)).toBe(ok);
  });

  test("repairs multiple embeds in one pass", () => {
    const md = "intro\n\n![[<page-001.png>]]\n\nmore\n\n![[<page-002.png>]]";
    const out = normalizeEmbeds(md);
    expect(out).toBe("intro\n\n![[page-001.png]]\n\nmore\n\n![[page-002.png]]");
  });

  test("double angle brackets are stripped too", () => {
    expect(normalizeEmbeds("![[<<page-003.png>>]]")).toBe("![[page-003.png]]");
  });
});

describe("normalizeFrontmatter", () => {
  const known = { page: 1, kind: "paper" };

  test("case 1: well-formed closed frontmatter — override page/kind, keep body", () => {
    const md = `---
title: X
page: 9
kind: old
---

body text`;
    const out = normalizeFrontmatter(md, known);
    expect(out).toBe(`---
title: X
page: 1
kind: paper
---

body text`);
  });

  test("case 2: UNCLOSED frontmatter — close it and override page/kind", () => {
    // The VLM forgot the closing --- (recurring gemma defect).
    const md = `---
title: X
page: 9
kind: old

body text`;
    const out = normalizeFrontmatter(md, known);
    expect(out).toBe(`---
title: X
page: 1
kind: paper
---

body text`);
  });

  test("case 3: no frontmatter at all — return unchanged (never invent one)", () => {
    const md = `# Hello\n\nbody text`;
    expect(normalizeFrontmatter(md, known)).toBe(md);
  });

  test("leading --- with no fields — return unchanged", () => {
    const md = `---\n\nbody`;
    expect(normalizeFrontmatter(md, known)).toBe(md);
  });

  test("a stray thematic-break --- later in the body is NOT mistaken for the closer", () => {
    const md = `---
title: X
page: 9
kind: old
---

intro

---

more`;
    const out = normalizeFrontmatter(md, known);
    // The body's thematic break survives; only the frontmatter page/kind change.
    expect(out.startsWith("---\ntitle: X\npage: 1\nkind: paper\n---\n")).toBe(true);
    expect(out.includes("\n---\n\nmore")).toBe(true);
  });

  test("override only touches EXISTING page/kind lines (does not invent missing ones)", () => {
    // The VLM emitted title only — no page/kind. The override regex matches
    // existing `page:`/`kind:` lines, so it must NOT fabricate them.
    const md = `---
title: X
---

body`;
    const out = normalizeFrontmatter(md, known);
    expect(out.startsWith("---\ntitle: X\n---\n")).toBe(true);
    expect(out.includes("page:")).toBe(false);
    expect(out.includes("kind:")).toBe(false);
  });
});

describe("pageUserMessage", () => {
  test("embeds docSlug, page, pageCount, and the verbatim png link line", () => {
    const msg = pageUserMessage({
      docSlug: "my-doc",
      page: 3,
      pngLinkName: "page-003.png",
      pageCount: 10,
    });
    expect(msg.includes("my-doc")).toBe(true);
    expect(msg.includes("第 3 頁")).toBe(true);
    expect(msg.includes("共 10 頁")).toBe(true);
    // The embed line must be exact — the VLM is told to echo it verbatim.
    expect(msg.includes("![[page-003.png]]")).toBe(true);
    expect(msg.includes("<page-003.png>")).toBe(false);
  });
});

describe("readImageContent", () => {
  test("returns a base64 image content block with the given mime type", () => {
    const block = readImageContent(join(dir, "page.png"), "image/png");
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    // PNG magic bytes 89 50 4e 47 → base64 "iVBORw"
    expect(block.data.startsWith("iVBORw")).toBe(true);
  });

  test("base64 decodes back to the original bytes", () => {
    const block = readImageContent(join(dir, "page.png"), "image/png");
    expect(Buffer.from(block.data, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
