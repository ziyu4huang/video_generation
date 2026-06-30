import { test, expect, describe } from "bun:test";
import { extractFinalAssistantText } from "../subagent-tool.ts";

describe("extractFinalAssistantText", () => {
  test("returns empty string for empty / non-JSON output", () => {
    expect(extractFinalAssistantText("")).toBe("");
    expect(extractFinalAssistantText("not json\nstill not")).toBe("");
  });

  test("extracts text from a single message_end event", () => {
    const ndjson =
      JSON.stringify({ type: "session", id: "abc" }) +
      "\n" +
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from subagent" }],
        },
      }) +
      "\n";
    expect(extractFinalAssistantText(ndjson)).toBe("Hello from subagent");
  });

  test("takes the LAST assistant message_end when several exist", () => {
    const e1 = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
    };
    const e2 = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    };
    const out = extractFinalAssistantText(`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
    expect(out).toBe("second");
  });

  test("ignores non-assistant message_end events", () => {
    const out = extractFinalAssistantText(
      JSON.stringify({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "ignored" }] },
      }) + "\n",
    );
    expect(out).toBe("");
  });

  test("ignores assistant messages whose text is only whitespace", () => {
    const out = extractFinalAssistantText(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "   " }] },
      }) + "\n",
    );
    expect(out).toBe("");
  });

  test("joins multiple text parts in one message", () => {
    const out = extractFinalAssistantText(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "part-a " },
            { type: "tool_use", name: "bash" },
            { type: "text", text: "part-b" },
          ],
        },
      }) + "\n",
    );
    expect(out).toBe("part-a part-b");
  });

  test("skips malformed JSON lines without throwing", () => {
    const blob =
      "{broken json\n" +
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      }) +
      "\n";
    expect(extractFinalAssistantText(blob)).toBe("ok");
  });
});
