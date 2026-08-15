import { test } from "bun:test";
import assert from "node:assert/strict";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";
import { createSubagentRunsTool } from "../src/subagent-runs-tool.js";

function mkRecord(over: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    id: "r1",
    toolCallId: "tc1",
    task: "do the thing",
    model: "zai/glm-5.2",
    cwd: "/repo",
    status: "done",
    startedAt: "2026-07-23T10:00:00Z",
    elapsedMs: 1500,
    output: "result text",
    ...over,
  };
}

/** In-memory fake persistence (list is newest-first by startedAt, like the real one). */
function fakePersistence(records: SubagentRunRecord[]): SubagentRunPersistence {
  return {
    save: () => {},
    list: () => [...records].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    load: (id) => records.find((r) => r.id === id) ?? null,
    delete: () => false,
    getRunsDir: () => "/tmp/fake",
  };
}

const NO_SIGNAL = undefined as unknown as AbortSignal;

test("list renders runs newest-first with #ordinal + id", async () => {
  const p = fakePersistence([
    mkRecord({ id: "old", startedAt: "2026-07-22T10:00:00Z" }),
    mkRecord({ id: "new", startedAt: "2026-07-23T10:00:00Z" }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("new"), true, "newest (r=2026-07-23) first");
  assert.equal(text.indexOf("new") < text.indexOf("old"), true, "newest before oldest");
  assert.equal(text.includes("id=new"), true);
});

test("list filters by status", async () => {
  const p = fakePersistence([mkRecord({ id: "ok", status: "done" }), mkRecord({ id: "bad", status: "failed" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list", status: "failed" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("id=bad"), true);
  assert.equal(text.includes("id=ok"), false);
});

test("list respects limit", async () => {
  const p = fakePersistence([mkRecord({ id: "a" }), mkRecord({ id: "b" }), mkRecord({ id: "c" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list", limit: 2 }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("id=c"), false, "only 2 of 3 (newest-first slice)");
});

test("list empty → clear message", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  assert.match((res.content[0] as { text: string }).text, /No subagent runs recorded/);
});

test("get found → output + metadata", async () => {
  const p = fakePersistence([mkRecord({ id: "r1", output: "the answer is 42" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "get", id: "r1" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /the answer is 42/);
  assert.match(text, /zai\/glm-5\.2/);
});

test("get not-found → clear message, no crash", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  const res = await tool.execute("id", { action: "get", id: "nope" }, NO_SIGNAL, undefined, undefined);
  assert.match((res.content[0] as { text: string }).text, /No subagent run with id "nope"/);
});

test("get includeHistory:true includes transcript; default omits", async () => {
  const p = fakePersistence([
    mkRecord({
      id: "r1",
      history: [{ role: "assistant", kind: "tool_call", text: "ran grep", toolName: "grep" } as never],
    }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const without = await tool.execute("id", { action: "get", id: "r1" }, NO_SIGNAL, undefined, undefined);
  const withHist = await tool.execute(
    "id",
    { action: "get", id: "r1", includeHistory: true },
    NO_SIGNAL,
    undefined,
    undefined,
  );
  assert.doesNotMatch((without.content[0] as { text: string }).text, /transcript/);
  assert.match((withHist.content[0] as { text: string }).text, /transcript/);
  assert.match((withHist.content[0] as { text: string }).text, /ran grep/);
});

test("get without id throws", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  assert.rejects(() => tool.execute("id", { action: "get" }, NO_SIGNAL, undefined, undefined), /requires id/);
});

test("createSubagentRunsTool → name 'subagent_runs'", () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  assert.equal(tool.name, "subagent_runs");
});
