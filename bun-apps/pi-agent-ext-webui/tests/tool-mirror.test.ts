import { describe, expect, it } from "bun:test";
import { createToolMirror, formatToolResult } from "../src/tool-mirror.js";
import { RenderService } from "../src/render-service.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** Build a synthetic tool_result (TextContent/ImageContent aren't SDK-root-
 *  exported; cast through Partial like the 06 plan's `{} as never`). */
function mkResult(over: Partial<ToolResultEvent> & { toolName: string }): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-abcdef1234",
    input: {},
    content: [],
    isError: false,
    ...over,
  } as ToolResultEvent;
}

describe("formatToolResult (T1 minimal: header + JSON fallback)", () => {
  it("emits the header line: ### 🔧 <toolName> + ✅ status + short toolCallId", () => {
    const out = formatToolResult(mkResult({ toolName: "bash", toolCallId: "abcdef1234567890" }));
    expect(out).toContain("### 🔧 bash");
    expect(out).toContain("✅");
    expect(out).toContain("abcdef1"); // first 8 chars of the toolCallId
  });

  it("uses ❌ when isError is true", () => {
    const out = formatToolResult(mkResult({ toolName: "bash", isError: true }));
    expect(out).toContain("❌");
  });

  it("falls back to truncated JSON for an unknown details shape (no throw)", () => {
    const out = formatToolResult(
      mkResult({ toolName: "mystery", details: { weird: [1, 2, { deep: true }] } })
    );
    expect(out).toContain("### 🔧 mystery");
    expect(out).toContain("```json");
    expect(out).toContain('"weird"');
  });

  it("never throws on a missing/undefined details", () => {
    expect(() => formatToolResult(mkResult({ toolName: "write", details: undefined }))).not.toThrow();
  });
});

describe("createToolMirror (T1 mechanism)", () => {
  it("a tool_result creates/updates the 'tools' view with mode 'md' and title 'Tools'", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(registry);
    handle(mkResult({ toolName: "bash", toolCallId: "cccc1111" }));
    const view = registry.getView("tools");
    expect(view).toBeDefined();
    expect(view!.mode).toBe("md");
    expect(view!.title).toBe("Tools");
    expect(view!.content).toContain("### 🔧 bash");
    expect(view!.content).toContain("cccc1111".slice(0, 8));
  });

  it("does not throw on any event shape", () => {
    const registry = new RenderService();
    const handle = createToolMirror(registry);
    expect(() => handle(mkResult({ toolName: "x", details: null }))).not.toThrow();
    expect(() => handle(mkResult({ toolName: "x", details: undefined }))).not.toThrow();
    expect(() => handle(mkResult({ toolName: "x", content: [{ type: "text", text: "hi" }] }))).not.toThrow();
  });
});
