import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "@repo/pi-agent-ext-core-runtime";
import type { ToolActionContext } from "@repo/pi-agent-ext-core-runtime";
import { formatToolAction, matchedCallArgsFor } from "@repo/pi-agent-ext-core-runtime";

function call(toolName: string, text: string, toolCallId?: string): AgentHistoryEntry {
  return { role: "assistant", kind: "toolCall", toolName, text, toolCallId };
}
function result(toolName: string, text = "ok", toolCallId?: string): AgentHistoryEntry {
  return { role: "tool", kind: "toolResult", toolName, text, isError: false, toolCallId };
}
function errEntry(toolName: string | undefined, text: string): AgentHistoryEntry {
  return { role: "tool", kind: "error", toolName, text, isError: true };
}
const withArgs = (args: Record<string, unknown>): ToolActionContext => ({ matchedCallArgs: args });

// ── curated verb table: present (toolCall) + past (toolResult w/ matched args) ──

test("read: present Reading / past Read", () => {
  assert.equal(formatToolAction(call("read", '{"path":"a.ts"}')), "Reading a.ts");
  assert.equal(formatToolAction(result("read"), withArgs({ path: "a.ts" })), "Read a.ts");
});

test("write: present Writing / past Wrote", () => {
  assert.equal(formatToolAction(call("write", '{"path":"b.ts"}')), "Writing b.ts");
  assert.equal(formatToolAction(result("write"), withArgs({ path: "b.ts" })), "Wrote b.ts");
});

test("edit: present Editing / past Edited", () => {
  assert.equal(formatToolAction(call("edit", '{"path":"c.ts"}')), "Editing c.ts");
  assert.equal(formatToolAction(result("edit"), withArgs({ path: "c.ts" })), "Edited c.ts");
});

test("bash: present Running: / past Ran: (command shown as first line)", () => {
  assert.equal(formatToolAction(call("bash", '{"command":"ls -la"}')), "Running: ls -la");
  assert.equal(formatToolAction(result("bash"), withArgs({ command: "ls -la" })), "Ran: ls -la");
});

test("grep: present Searching for / past Searched for (pattern quoted)", () => {
  assert.equal(formatToolAction(call("grep", '{"pattern":"foo"}')), 'Searching for "foo"');
  assert.equal(formatToolAction(result("grep"), withArgs({ pattern: "foo" })), 'Searched for "foo"');
});

test("find: present Finding / past Found (pattern quoted)", () => {
  assert.equal(formatToolAction(call("find", '{"pattern":"*.ts"}')), 'Finding "*.ts"');
  assert.equal(formatToolAction(result("find"), withArgs({ pattern: "*.ts" })), 'Found "*.ts"');
});

test("ls: present Listing / past Listed", () => {
  assert.equal(formatToolAction(call("ls", '{"path":"src"}')), "Listing src");
  assert.equal(formatToolAction(result("ls"), withArgs({ path: "src" })), "Listed src");
});

test("web_search: present Searching web for / past Searched web (past drops target)", () => {
  assert.equal(formatToolAction(call("web_search", '{"query":"rust async"}')), 'Searching web for "rust async"');
  assert.equal(formatToolAction(result("web_search"), withArgs({ query: "rust async" })), "Searched web");
});

test("fetch_content: present Fetching / past Fetched", () => {
  assert.equal(formatToolAction(call("fetch_content", '{"url":"http://x.io"}')), "Fetching http://x.io");
  assert.equal(formatToolAction(result("fetch_content"), withArgs({ url: "http://x.io" })), "Fetched http://x.io");
});

test("subagent: present Dispatching subagent / past Dispatched subagent (past drops target)", () => {
  assert.equal(formatToolAction(call("subagent", '{"task":"do X"}')), 'Dispatching subagent "do X"');
  assert.equal(formatToolAction(result("subagent"), withArgs({ task: "do X" })), "Dispatched subagent");
});

test("subagents: present/past carry N (tasks.length, pluralized)", () => {
  assert.equal(formatToolAction(call("subagents", '{"tasks":["a","b"]}')), "Dispatching 2 subagents");
  assert.equal(formatToolAction(result("subagents"), withArgs({ tasks: ["a", "b"] })), "Dispatched 2 subagents");
  // singular pluralization
  assert.equal(formatToolAction(call("subagents", '{"tasks":["a"]}')), "Dispatching 1 subagent");
});

test("ask_user_question: present Asking / past Asked (questions.length)", () => {
  assert.equal(formatToolAction(call("ask_user_question", '{"questions":["q1","q2"]}')), "Asking 2 questions");
  assert.equal(
    formatToolAction(result("ask_user_question"), withArgs({ questions: ["q1", "q2"] })),
    "Asked 2 questions",
  );
});

// ── arg extraction priority ──

test("per-tool key wins over generic keys", () => {
  // read has both `path` (per-tool) and `name` (generic) → per-tool wins.
  assert.equal(formatToolAction(call("read", '{"name":"n","path":"a.ts"}')), "Reading a.ts");
});

test("generic-key fallback: Using/Used <value> when per-tool key absent", () => {
  // read without `path` but with `file` → generic Using <file value>.
  assert.equal(formatToolAction(call("read", '{"file":"other.ts"}')), "Using other.ts");
  assert.equal(formatToolAction(result("read"), withArgs({ file: "other.ts" })), "Used other.ts");
});

test("toolName fallback: Using/Used <tool> when no key recoverable", () => {
  assert.equal(formatToolAction(call("read", "{}")), "Using read");
  assert.equal(formatToolAction(result("read"), withArgs({})), "Used read");
});

// ── unknown tool ──

test("unknown tool krea2 → Using krea2 / Used krea2", () => {
  // an arg that IS a generic key (name) → Using <value> via generic fallback
  assert.equal(formatToolAction(call("krea2", '{"name":"img"}')), "Using img");
  // no recognized key / empty → toolName fallback
  assert.equal(formatToolAction(call("krea2", '{"prompt":"hi"}')), "Using krea2");
  assert.equal(formatToolAction(call("krea2", "{}")), "Using krea2");
  assert.equal(formatToolAction(result("krea2"), withArgs({})), "Used krea2");
});

// ── parse tolerance ──

test("empty `{}` args → toolName fallback (no throw)", () => {
  assert.equal(formatToolAction(call("grep", "{}")), "Using grep");
});

test("truncated JSON payload → regex-scrape recovers the key", () => {
  // compactAgentHistory caps text at 2000 chars and appends `... [truncated]`,
  // which can split the JSON mid-value. The scraper still recovers known keys.
  const truncated = '{"path":"src/deeply/nested/file.ts","text":"abc... [truncated]';
  assert.equal(formatToolAction(call("read", truncated)), "Reading src/deeply/nested/file.ts");
});

test("non-JSON text → scraper finds a quoted key, else toolName fallback", () => {
  // non-JSON but contains a recognized key in quotes
  assert.equal(formatToolAction(call("read", 'blah "path":"x.ts" trailing')), "Reading x.ts");
  // non-JSON with NO recognized key → toolName fallback, never throws
  assert.equal(formatToolAction(call("read", "totally not json at all")), "Using read");
});

// ── matchedCallArgsFor ──

test("matchedCallArgsFor: paired result recovers the call's args", () => {
  const history: AgentHistoryEntry[] = [call("read", '{"path":"a.ts"}'), result("read")];
  assert.deepEqual(matchedCallArgsFor(history, 1), { path: "a.ts" });
  // → phrase shows the target (history[1] is the result() entry built above)
  assert.equal(formatToolAction(history[1]!, withArgs(matchedCallArgsFor(history, 1) ?? {})), "Read a.ts");
});

test("matchedCallArgsFor: orphan result (no preceding call) → undefined → verb-only", () => {
  const history: AgentHistoryEntry[] = [result("read")];
  assert.equal(matchedCallArgsFor(history, 0), undefined);
  // history[0] is the single result() entry built above
  assert.equal(formatToolAction(history[0]!), "Read");
});

test("matchedCallArgsFor: skips a different tool to find the matching call", () => {
  const history: AgentHistoryEntry[] = [
    call("read", '{"path":"a.ts"}'),
    call("grep", '{"pattern":"x"}'),
    result("read"),
  ];
  assert.deepEqual(matchedCallArgsFor(history, 2), { path: "a.ts" });
});

test("matchedCallArgsFor returns undefined for non-result/error entries", () => {
  const history: AgentHistoryEntry[] = [call("read", '{"path":"a.ts"}')];
  assert.equal(matchedCallArgsFor(history, 0), undefined);
  assert.equal(matchedCallArgsFor([], 0), undefined);
});

// ── batched pairing by toolCallId (trace-fidelity fix) ──

test("matchedCallArgsFor: batched same-tool results pair by toolCallId (each resolves its OWN call)", () => {
  // The exact symptom: one assistant turn emits [read PRD, read chromadb, read map]
  // (distinct ids), then [result, result, result] follow. Pre-fix the
  // nearest-preceding-same-name scan resolved ALL three to the LAST call (map.md);
  // post-fix each result resolves its OWN call's args by id.
  const history: AgentHistoryEntry[] = [
    call("read", '{"path":"PRD.md"}', "tc1"),
    call("read", '{"path":"chromadb.md"}', "tc2"),
    call("read", '{"path":"map.md"}', "tc3"),
    result("read", "PRD body", "tc1"),
    result("read", "chromadb body", "tc2"),
    result("read", "map body", "tc3"),
  ];
  // results at indices 3, 4, 5
  assert.deepEqual(matchedCallArgsFor(history, 3), { path: "PRD.md" });
  assert.deepEqual(matchedCallArgsFor(history, 4), { path: "chromadb.md" });
  assert.deepEqual(matchedCallArgsFor(history, 5), { path: "map.md" });
});

test("matchedCallArgsFor: legacy (no toolCallId) still falls back to nearest-preceding-same-name", () => {
  // When ids are absent (older transcripts), the name-based backward scan is the
  // only signal — it must still work unchanged (backwards compat).
  const history: AgentHistoryEntry[] = [
    call("read", '{"path":"PRD.md"}'),
    call("read", '{"path":"map.md"}'),
    result("read"),
  ];
  // No ids → nearest-preceding-same-name → the last read call (map.md).
  assert.deepEqual(matchedCallArgsFor(history, 2), { path: "map.md" });
});

test("matchedCallArgsFor: result id with no matching call id → name fallback (graceful)", () => {
  // Result carries a toolCallId but no preceding call shares it (truncated window /
  // mismatched upstream). Must degrade to name-based pairing, NOT return undefined.
  const history: AgentHistoryEntry[] = [call("read", '{"path":"map.md"}'), result("read", "body", "tc-x")];
  assert.deepEqual(matchedCallArgsFor(history, 1), { path: "map.md" });
});

// ── error ──

test("error: Failed to <verb> <target> (tool error with matched args)", () => {
  const e = errEntry("read", "");
  assert.equal(formatToolAction(e, withArgs({ path: "X" })), "Failed to read X");
});

test("error: appends `: <first line>` when detail present", () => {
  const e = errEntry("bash", "command not found: foo");
  assert.equal(formatToolAction(e), "Failed to run: command not found: foo");
});

test("error: known tool no target → `Failed to <stem>`", () => {
  const e = errEntry("read", "");
  assert.equal(formatToolAction(e), "Failed to read");
});

test("error: unknown tool → `Failed (<tool>)`", () => {
  const e = errEntry("krea2", "boom");
  assert.equal(formatToolAction(e), "Failed (krea2): boom");
});

test("error: whole-turn assistant error (no toolName) → `⚠ <first line>`", () => {
  const e: AgentHistoryEntry = { role: "assistant", kind: "error", text: "model failed" };
  assert.equal(formatToolAction(e), "⚠ model failed");
});

// ── text / idle ──

test("text entry → first line (≤60)", () => {
  assert.equal(
    formatToolAction({ role: "assistant", kind: "text", text: "I will look next.\nmore" }),
    "I will look next.",
  );
});

test("empty text entry → `…thinking`", () => {
  assert.equal(formatToolAction({ role: "assistant", kind: "text", text: "" }), "…thinking");
});
