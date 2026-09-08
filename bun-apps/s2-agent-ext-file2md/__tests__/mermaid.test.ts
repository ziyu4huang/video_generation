/**
 * mermaid.test.ts — the light D15 contract: fence + known keyword passes,
 * anything else unwraps to prose, prose is never touched, and a mocked-E2E
 * proves a valid block survives into a `## Figure (vision)` append.
 */
import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeMermaid, sanitizeMermaidBlocks } from "../src/vlm/mermaid.ts";

describe("looksLikeMermaid", () => {
  test("accepts the common diagram keywords", () => {
    for (const head of [
      "graph TD",
      "flowchart LR",
      "sequenceDiagram",
      "stateDiagram-v2",
      "classDiagram",
      "erDiagram",
      "mindmap",
      "pie",
      "gantt",
      "timeline",
    ]) {
      expect(looksLikeMermaid(head)).toBe(true);
    }
  });

  test("rejects prose and unknown keywords", () => {
    expect(looksLikeMermaid("This is a diagram of things.")).toBe(false);
    expect(looksLikeMermaid("not-a-diagram A --> B")).toBe(false);
    expect(looksLikeMermaid("")).toBe(false);
  });
});

describe("sanitizeMermaidBlocks", () => {
  test("a valid block passes through untouched", () => {
    const md = "Description.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
    expect(sanitizeMermaidBlocks(md)).toBe(md);
  });

  test("an invalid block is unwrapped, body kept as prose", () => {
    const md = "Text before.\n\n```mermaid\nsome random lines\nnot mermaid\n```\n";
    expect(sanitizeMermaidBlocks(md)).toBe("Text before.\n\nsome random lines\nnot mermaid\n");
  });

  test("mixed valid + invalid blocks: only the bad one unwraps", () => {
    const md = "```mermaid\ngraph TD\n  X --> Y\n```\nmid\n```mermaid\nblah\n```\n";
    expect(sanitizeMermaidBlocks(md)).toBe("```mermaid\ngraph TD\n  X --> Y\n```\nmid\nblah\n");
  });

  test("prose without fences is untouched", () => {
    const md = "Just a description with `inline code` and no fences.";
    expect(sanitizeMermaidBlocks(md)).toBe(md);
  });
});

// --- mocked E2E: a mermaid block survives into ## Figure (vision) -----------

const visionReply = { output: "" };

mock.module("../src/sessions.ts", () => ({
  resolveVisionLLM: () => ({ provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "off" as const }),
}));
mock.module("../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async () => ({ output: visionReply.output, ok: true }),
}));

const { explainPage } = await import("../src/vlm/agents.ts");

const IMG = join(tmpdir(), `file2md-mermaid-${process.pid}.png`);
await Bun.write(IMG, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

describe("explainPage figure variant carries mermaid", () => {
  test("valid mermaid block reaches the returned description intact", async () => {
    visionReply.output = "A pipeline.\n\n```mermaid\nflowchart LR\n  Ingest --> Convert --> Emit\n```\n";
    const r = await explainPage({ provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "off" }, "diagram", {
      imageAbs: IMG,
      mimeType: "image/png",
      pngLinkName: "page-001.png",
      docSlug: "d",
      pageNo: 1,
      pageCount: 1,
      figure: true,
    });
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain("```mermaid\nflowchart LR");
  });

  test("a junk fence is unwrapped before it reaches the description", async () => {
    visionReply.output = "Words.\n\n```mermaid\ndiagram-ish garbage\n```\n";
    const r = await explainPage({ provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "off" }, "diagram", {
      imageAbs: IMG,
      mimeType: "image/png",
      pngLinkName: "page-001.png",
      docSlug: "d",
      pageNo: 1,
      pageCount: 1,
      figure: true,
    });
    expect(r.ok).toBe(true);
    expect(r.markdown).not.toContain("```mermaid");
    expect(r.markdown).toContain("diagram-ish garbage");
  });
});
