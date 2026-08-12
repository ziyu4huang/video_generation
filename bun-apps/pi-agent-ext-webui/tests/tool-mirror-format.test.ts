import { describe, expect, it } from "bun:test";
import { formatToolResult } from "../src/tool-mirror.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

function mkResult(over: Partial<ToolResultEvent> & { toolName: string }): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-xyz",
    input: {},
    content: [],
    isError: false,
    ...over,
  } as ToolResultEvent;
}

describe("formatToolResult — built-in tools (pins 04-spec §8 details shapes)", () => {
  it("edit -> fenced diff block from details.diff + firstChangedLine note", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "edit",
        details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new", patch: "@@@", firstChangedLine: 3 },
      })
    );
    expect(out).toContain("### 🔧 edit");
    expect(out).toContain("```diff");
    expect(out).toContain("-old");
    expect(out).toContain("+new");
    expect(out).toContain("first changed line");
    expect(out.toLowerCase()).toContain("3");
  });

  it("bash -> stdout snippet from content text + fullOutputPath as inline code (no dump of details)", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "bash",
        content: [{ type: "text", text: "hello stdout\nline2" }],
        details: { truncation: undefined, fullOutputPath: "/tmp/out.log" },
      })
    );
    expect(out).toContain("### 🔧 bash");
    expect(out).toContain("hello stdout");
    expect(out).toContain("`/tmp/out.log`"); // path shown as TEXT (inline code)
    expect(out).not.toContain("```diff");
  });

  it("bash -> shows a truncation note when details.truncation.truncated", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "bash",
        content: [{ type: "text", text: "x" }],
        details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 10, totalLines: 100, firstLineExceedsLimit: false, maxLines: 10, maxBytes: 50000 } },
      })
    );
    expect(out.toLowerCase()).toContain("truncat");
  });

  it("read/grep/find/ls -> ONE-LINE metadata note only, NO content dump", () => {
    const grep = formatToolResult(
      mkResult({ toolName: "grep", details: { matchLimitReached: 50, linesTruncated: true } })
    );
    expect(grep).toContain("### 🔧 grep");
    expect(grep).toContain("50"); // matchLimitReached surfaced
    // a one-line note — assert the body has no big content dump (no fenced block)
    expect(grep).not.toContain("```");
  });

  it("ls -> entryLimitReached surfaced as a one-line note", () => {
    const ls = formatToolResult(
      mkResult({ toolName: "ls", details: { entryLimitReached: 100 } })
    );
    expect(ls).toContain("### 🔧 ls");
    expect(ls).toContain("100");
    expect(ls).not.toContain("```");
  });

  it("write -> '(no details)' (details is undefined by SDK type)", () => {
    const out = formatToolResult(mkResult({ toolName: "write", details: undefined }));
    expect(out).toContain("### 🔧 write");
    expect(out).toMatch(/\(no details\)/);
  });
});

describe("formatToolResult — custom tools (generic key-value, paths as TEXT)", () => {
  it("image-gen details -> key-value md of stable fields; outputs[] paths as inline code", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "image", // custom toolName (no guard matches)
        details: {
          ok: true,
          command: "run.py image t2i",
          exitCode: 0,
          outputs: ["/out/a.png", "/out/b.png"],
          manifestPath: "/out/manifest.json",
          model: "z-image",
          elapsedSeconds: 12.5,
          stdout: "done",
        },
      })
    );
    expect(out).toContain("### 🔧 image");
    expect(out).toContain("ok");
    expect(out).toContain("run.py image t2i");
    expect(out).toContain("`/out/a.png`"); // path as TEXT (inline code), NOT <img>
    expect(out).toContain("z-image");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<video");
  });

  it("video-gen details -> key-value md; output/manifest/gate as text", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "video",
        details: { ok: true, exitCode: 0, output: "/out/v.mp4", manifest: "/out/m.json", gate: "passed", stdout: "rendered" },
      })
    );
    expect(out).toContain("### 🔧 video");
    expect(out).toContain("`/out/v.mp4`");
    expect(out).toContain("passed");
    expect(out).not.toContain("<video");
  });

  it("per-field truncation: an oversized stdout is capped (ellipsis)", () => {
    const big = "x".repeat(5000);
    const out = formatToolResult(
      mkResult({ toolName: "bash", content: [{ type: "text", text: big }], details: undefined })
    );
    expect(out).toContain("truncat");
    expect(out.length).toBeLessThan(big.length);
  });

  it("unknown custom details (non-object) -> truncated JSON fallback, no throw", () => {
    const out = formatToolResult(mkResult({ toolName: "weird", details: "just a string" }));
    expect(out).toContain("```json");
    expect(out).toContain("just a string");
  });
});
