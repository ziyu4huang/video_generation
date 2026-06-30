import { test, expect, describe } from "bun:test";
import { truncate, extractText, formatHistoryLine } from "../sessions/chat-loop.ts";

describe("truncate", () => {
  test("passes through short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("collapses internal whitespace", () => {
    expect(truncate("a   b\n\tc", 10)).toBe("a b c");
  });

  test("trims surrounding whitespace", () => {
    expect(truncate("  pad  ", 10)).toBe("pad");
  });

  test("appends ellipsis when over the limit", () => {
    const out = truncate("abcdefghijKLMNOP", 10);
    expect(out.startsWith("abcdefghij")).toBe(true);
    expect(out.endsWith(" …")).toBe(true);
    expect(out.length).toBe(12); // 10 chars + " …"
  });

  test("boundary: exactly at the limit is not truncated", () => {
    expect(truncate("1234567890", 10)).toBe("1234567890");
  });
});

describe("extractText", () => {
  test("returns a plain string as-is", () => {
    expect(extractText("plain")).toBe("plain");
  });

  test("returns empty string for non-array content", () => {
    expect(extractText({ foo: "bar" })).toBe("");
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  test("joins only text parts from a content array", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "x", name: "bash" },
      { type: "text", text: "world" },
    ];
    expect(extractText(content)).toBe("Hello world");
  });

  test("returns empty string when there are no text parts", () => {
    expect(extractText([{ type: "tool_use", name: "bash" }])).toBe("");
  });
});

describe("formatHistoryLine", () => {
  test("user message: string content", () => {
    const line = formatHistoryLine({ role: "user", content: "list files" });
    expect(line.startsWith("you  ")).toBe(true);
    expect(line).toContain("list files");
  });

  test("user message: array content is extracted", () => {
    const line = formatHistoryLine({
      role: "user",
      content: [{ type: "text", text: "from array" }],
    });
    expect(line).toContain("from array");
  });

  test("assistant message with text", () => {
    const line = formatHistoryLine({
      role: "assistant",
      content: [{ type: "text", text: "sure thing" }],
    });
    expect(line.startsWith("ai   ")).toBe(true);
    expect(line).toContain("sure thing");
  });

  test("assistant message with no text", () => {
    const line = formatHistoryLine({
      role: "assistant",
      content: [{ type: "tool_use", name: "bash" }],
    });
    expect(line).toContain("(no text — tool calls only)");
  });

  test("toolResult message", () => {
    const line = formatHistoryLine({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(line.startsWith("tool ")).toBe(true);
    expect(line).toContain("bash");
    expect(line).toContain("ok");
  });

  test("toolResult message marks errors", () => {
    const line = formatHistoryLine({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    expect(line.endsWith("(err)")).toBe(true);
  });

  test("unknown role falls back to JSON", () => {
    const line = formatHistoryLine({ role: "system", content: { x: 1 } });
    expect(line.startsWith("•    ")).toBe(true);
    expect(line).toContain('"x":1');
  });
});
