import { test } from "bun:test";
import assert from "node:assert/strict";
import { compactAgentHistory, summarizeLatestAction } from "@repo/pi-agent-ext-core-runtime";

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

test("compactAgentHistory threads toolCallId: batched calls carry their OWN id (block.id)", () => {
  // A single assistant turn batched THREE distinct reads; each toolCall block's
  // `id` must surface on the compacted entry so results can later pair by id
  // (not resolve all to the last call). This is the data-model half of the
  // batched-trace fidelity fix.
  const history = compactAgentHistory([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "PRD.md" } },
        { type: "toolCall", id: "tc2", name: "read", arguments: { path: "chromadb.md" } },
        { type: "toolCall", id: "tc3", name: "read", arguments: { path: "map.md" } },
      ],
      timestamp: 1,
    },
  ]);

  const calls = history.filter((e) => e.kind === "toolCall");
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((e) => e.toolCallId),
    ["tc1", "tc2", "tc3"],
  );
});

test("compactAgentHistory threads toolCallId: batched results carry their OWN id (message.toolCallId)", () => {
  // The exact batched symptom: one turn emits N calls, then N matching results
  // (order preserved). Each result entry must carry the id of ITS OWN call, not
  // the last call's — pre-fix this was the root of three identical `✓ Read map.md`.
  const history = compactAgentHistory([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "PRD.md" } },
        { type: "toolCall", id: "tc2", name: "read", arguments: { path: "chromadb.md" } },
        { type: "toolCall", id: "tc3", name: "read", arguments: { path: "map.md" } },
      ],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: [{ type: "text", text: "PRD body" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "tc2",
      toolName: "read",
      content: [{ type: "text", text: "chromadb body" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "tc3",
      toolName: "read",
      content: [{ type: "text", text: "map body" }],
      isError: false,
      timestamp: 4,
    },
  ]);

  const results = history.filter((e) => e.kind === "toolResult");
  assert.equal(results.length, 3);
  // Each result carries its OWN id — NOT all "tc3" (the last call).
  assert.deepEqual(
    results.map((e) => e.toolCallId),
    ["tc1", "tc2", "tc3"],
  );
});

test("compactAgentHistory: toolCallId is OPTIONAL — legacy/missing ids stay undefined (no regression)", () => {
  // Backwards compatibility: a toolCall block without `id` and a toolResult
  // message without `toolCallId` (older transcripts) must still compact fine,
  // with toolCallId simply absent — the name-fallback labeler still works.
  const history = compactAgentHistory([
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
      timestamp: 1,
    },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "a body" }], isError: false, timestamp: 2 },
  ]);

  assert.equal(history[0].toolCallId, undefined);
  assert.equal(history[1].toolCallId, undefined);
  // Existing fields unchanged.
  assert.equal(history[0].toolName, "read");
  assert.equal(history[1].kind, "toolResult");
});
