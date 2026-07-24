import { test } from "bun:test";
import assert from "node:assert/strict";
import { compactAgentHistory, summarizeLatestAction } from "../src/agent-history.js";

test("compactAgentHistory captures user, assistant, tool call, and tool result entries", () => {
  const history = compactAgentHistory([
    { role: "user", content: "inspect repo", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", name: "read", arguments: { file: "README.md" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "README content" }],
      isError: false,
      timestamp: 3,
    },
  ]);

  assert.deepEqual(
    history.map((entry) => [entry.role, entry.kind, entry.toolName, entry.text]),
    [
      ["user", "text", undefined, "inspect repo"],
      ["assistant", "text", undefined, "I will inspect it."],
      ["assistant", "toolCall", "read", '{"file":"README.md"}'],
      ["tool", "toolResult", "read", "README content"],
    ],
  );
});

test("compactAgentHistory records assistant and tool errors", () => {
  const history = compactAgentHistory([
    {
      role: "assistant",
      content: [],
      errorMessage: "model failed",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "exit 1" }],
      isError: true,
      timestamp: 2,
    },
  ]);

  assert.equal(history[0].kind, "error");
  assert.equal(history[0].text, "model failed");
  assert.equal(history[1].kind, "error");
  assert.equal(history[1].toolName, "bash");
  assert.equal(history[1].isError, true);
});

test("compactAgentHistory truncates text and keeps the latest entries", () => {
  const history = compactAgentHistory(
    [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "assistant", content: [{ type: "text", text: "Z".repeat(100) }] },
    ],
    { maxEntries: 2, maxTextChars: 30, maxTotalChars: 60 },
  );

  assert.equal(history.length, 2);
  assert.equal(history[0].text, "middle");
  assert.match(history[1].text, /truncated/);
  assert.ok(history[1].text.length <= 30);
});

test("summarizeLatestAction returns undefined for empty or missing history", () => {
  assert.equal(summarizeLatestAction(undefined), undefined);
  assert.equal(summarizeLatestAction([]), undefined);
});

test("summarizeLatestAction summarizes a toolCall entry", () => {
  const action = summarizeLatestAction([
    { role: "assistant", kind: "toolCall", toolName: "grep", text: '{"pattern":"foo"}' },
  ]);
  assert.equal(action, "▸ grep");
});

test("summarizeLatestAction summarizes a successful toolResult entry", () => {
  const action = summarizeLatestAction([
    { role: "tool", kind: "toolResult", toolName: "grep", text: "3 matches", isError: false },
  ]);
  assert.equal(action, "grep done");
});

test("summarizeLatestAction summarizes a failed toolResult entry", () => {
  const action = summarizeLatestAction([
    { role: "tool", kind: "toolResult", toolName: "bash", text: "exit 1", isError: true },
  ]);
  assert.equal(action, "✗ bash");
});

test("summarizeLatestAction summarizes an error entry", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "error", text: "model failed" }]);
  assert.equal(action, "✗ error");
});

test("summarizeLatestAction summarizes a plain text entry as thinking", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "text", text: "I will look at this next." }]);
  assert.equal(action, "…thinking");
});

test("summarizeLatestAction only looks at the LAST entry", () => {
  const action = summarizeLatestAction([
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
    { role: "tool", kind: "toolResult", toolName: "read", text: "content", isError: false },
  ]);
  assert.equal(action, "read done");
});

test("summarizeLatestAction falls back to a generic 'tool' label when toolName is missing", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "toolCall", text: "{}" }]);
  assert.equal(action, "▸ tool");
});
