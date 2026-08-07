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
  assert.equal(action, 'Searching for "foo"');
});

test("summarizeLatestAction summarizes a successful toolResult entry", () => {
  // orphan result (no preceding call) → verb-only past
  const action = summarizeLatestAction([
    { role: "tool", kind: "toolResult", toolName: "grep", text: "3 matches", isError: false },
  ]);
  assert.equal(action, "Searched");
});

test("summarizeLatestAction summarizes a failed toolResult entry", () => {
  // compactAgentHistory maps isError → kind:"error"; a failed toolResult is an
  // error entry in practice, so model it that way here.
  const action = summarizeLatestAction([
    { role: "tool", kind: "error", toolName: "bash", text: "exit 1", isError: true },
  ]);
  assert.equal(action, "Failed to run: exit 1");
});

test("summarizeLatestAction summarizes an error entry", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "error", text: "model failed" }]);
  assert.equal(action, "⚠ model failed");
});

test("summarizeLatestAction summarizes a plain text entry as its first line", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "text", text: "I will look at this next." }]);
  assert.equal(action, "I will look at this next.");
});

test("summarizeLatestAction only looks at the LAST entry", () => {
  const action = summarizeLatestAction([
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
    { role: "tool", kind: "toolResult", toolName: "read", text: "content", isError: false },
  ]);
  // paired result: the preceding call had empty args → no target → generic toolName past
  assert.equal(action, "Used read");
});

test("summarizeLatestAction falls back to a generic 'tool' label when toolName is missing", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "toolCall", text: "{}" }]);
  assert.equal(action, "Using tool");
});
