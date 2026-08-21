import { describe, expect, test } from "bun:test";
import { collectUserMessages } from "./user-messages.ts";

const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as never;
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never;

describe("collectUserMessages", () => {
  test("collects user text verbatim, numbered 1-based, skips assistants", () => {
    const out = collectUserMessages([user("fix the bug"), assistant("ok"), user("thanks")]);
    expect(out).toEqual([
      { index: 1, text: "fix the bug", truncated: false },
      { index: 2, text: "thanks", truncated: false },
    ]);
  });
  test("truncates over maxChars", () => {
    const out = collectUserMessages([user("a".repeat(50))], 50, 10);
    expect(out[0].truncated).toBe(true);
    expect(out[0].text.length).toBeLessThanOrEqual(20);
    expect(out[0].text.startsWith("aaaaaaaa")).toBe(true);
  });
  test("caps at max messages", () => {
    const many = Array.from({ length: 60 }, (_, i) => user(`m${i}`));
    expect(collectUserMessages(many).length).toBe(50);
  });
  test("skips empty/whitespace and non-text user content", () => {
    const out = collectUserMessages([user("   "), { role: "user", content: [{ type: "toolResult", id: "t" }] } as never]);
    expect(out).toEqual([]);
  });
});
