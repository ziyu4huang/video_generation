import { describe, expect, it } from "bun:test";
import { createToolMirror } from "../src/tool-mirror.js";
import { RenderService } from "../src/render-service.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

function mkResult(toolName: string, id: string, text = "x"): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: id,
    input: {},
    content: [{ type: "text", text }],
    isError: false,
    toolName,
  } as ToolResultEvent;
}

function logOf(r: RenderService): string {
  return r.getView("tools")?.content ?? "";
}

describe("createToolMirror — rolling accumulation + cap", () => {
  it("accumulates entries separated by a horizontal rule", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 50, maxChars: 20000 });
    handle(mkResult("bash", "id1"));
    handle(mkResult("bash", "id2"));
    expect(logOf(r)).toContain("### 🔧 bash");
    expect(logOf(r)).toContain("`id1`".slice(0, 0) + "id1".slice(0, 8)); // id1 present
    expect(logOf(r)).toContain("---"); // entry separator
    expect(logOf(r).match(/### 🔧 bash/g)?.length).toBe(2);
  });

  it("drops the OLDEST entry once maxEntries is exceeded", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 3, maxChars: 100000 });
    handle(mkResult("bash", "aaaa1111"));
    handle(mkResult("bash", "bbbb2222"));
    handle(mkResult("bash", "cccc3333"));
    handle(mkResult("bash", "dddd4444")); // exceeds 3 -> drop aaaa
    const log = logOf(r);
    expect(log).not.toContain("aaaa1");
    expect(log).toContain("bbbb2");
    expect(log).toContain("dddd4");
    expect(log.match(/### 🔧 bash/g)?.length).toBe(3);
  });

  it("enforces the char budget by dropping oldest entries", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 1000, maxChars: 500 });
    for (let i = 0; i < 10; i++) handle(mkResult("bash", `id${i}00000000`, "y".repeat(80)));
    expect(logOf(r).length).toBeLessThanOrEqual(500);
    // the most recent entry is present; the earliest are dropped
    expect(logOf(r)).toContain("id9000000".slice(0, 8));
  });

  it("a SINGLE entry larger than maxChars is itself truncated (never exceeds budget)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 50, maxChars: 300 });
    handle(mkResult("bash", "big00000", "z".repeat(5000)));
    expect(logOf(r).length).toBeLessThanOrEqual(300);
    expect(logOf(r)).toContain("### 🔧 bash");
  });

  it("rapid tool_results never grow the log unbounded (count AND size bounded)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r); // defaults 50 / 20000
    for (let i = 0; i < 500; i++) handle(mkResult("bash", `${i}0000000000`, "w".repeat(50)));
    const log = logOf(r);
    expect(log.length).toBeLessThanOrEqual(20000);
    expect(log.match(/### 🔧 bash/g)?.length ?? 0).toBeLessThanOrEqual(50);
  });
});
