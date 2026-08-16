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

function mkUsage(total: number): SubagentRunRecord["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0 };
}

test("list header: line 1 describes the archive; line 2 stats over filtered set with limit slicing", async () => {
  const p = fakePersistence([
    mkRecord({ id: "r1", status: "done", usage: mkUsage(100_000) }),
    mkRecord({ id: "r2", status: "failed", usage: mkUsage(50_000) }),
    mkRecord({ id: "r3", status: "done", usage: mkUsage(242_000) }),
    mkRecord({ id: "r4", status: "timedout" }),
    mkRecord({ id: "r5", status: "turns" }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list", limit: 3 }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "Subagent run history — read-only archive of past subagent/subagents dispatches (~/.pi/subagents/runs)",
  );
  // Counts come from the post-filter pre-slice set (5 rows): done 2 · failed 1
  // · timedout 1 · turns 1 · budget 0. Token total is over the 3 shown rows
  // (392k), span over shown startedAt values (all same day → same stamp).
  assert.equal(
    lines[1],
    "Showing 3 most recent of 5 total · done 2 · failed 1 · timedout 1 · turns 1 · budget 0 · 392k tok total · span 07-23 10:00→07-23 10:00",
  );
  assert.match(lines[2], /^#1 {2}\[done\] {2}zai\/glm-5\.2/);
  assert.equal(lines.filter((l) => l.startsWith("#")).length, 3, "exactly 3 rows rendered");
});

test("list header: token total M-case at/above 1e6", async () => {
  const p = fakePersistence([
    mkRecord({ id: "r1", startedAt: "2026-08-16T02:13:00Z", usage: mkUsage(800_000) }),
    mkRecord({ id: "r2", startedAt: "2026-07-23T10:00:00Z", usage: mkUsage(900_000) }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const lines = (res.content[0] as { text: string }).text.split("\n");
  assert.match(lines[1], /1\.7M tok total/);
  assert.match(lines[1], /span 07-23 10:00→08-16 02:13/); // oldest→newest among shown
});

test("list header: token total 0 when no usage", async () => {
  const p = fakePersistence([mkRecord({ id: "r1" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const lines = (res.content[0] as { text: string }).text.split("\n");
  assert.match(lines[1], /0 tok total/);
  assert.match(lines[1], /span 07-23 10:00$/); // single shown row → lone stamp
});

test("list header: status/cwd filters annotate the end of line 2; counts are post-filter", async () => {
  const p = fakePersistence([
    mkRecord({ id: "ok1", status: "done", cwd: "/repo" }),
    mkRecord({ id: "ok2", status: "done", cwd: "/other" }),
    mkRecord({ id: "bad", status: "failed", cwd: "/repo" }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute(
    "id",
    { action: "list", status: "done", cwd: "/repo" },
    NO_SIGNAL,
    undefined,
    undefined,
  );
  const lines = (res.content[0] as { text: string }).text.split("\n");
  assert.match(
    lines[1],
    /Showing 1 most recent of 1 total · done 1 · failed 0 · timedout 0 · turns 0 · budget 0 · 0 tok total · span 07-23 10:00 · filter: status=done · filter: cwd=\/repo$/,
  );
});

test("list header: statuses beyond the five named ones append without crashing", async () => {
  const p = fakePersistence([mkRecord({ id: "a", status: "aborted" }), mkRecord({ id: "b", status: "done" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const lines = (res.content[0] as { text: string }).text.split("\n");
  assert.match(lines[1], /done 1 · failed 0 · timedout 0 · turns 0 · budget 0 · aborted 1 ·/);
});

test("list empty → headers first, then graceful no-match line", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  const lines = text.split("\n");
  assert.match(lines[0], /Subagent run history — read-only archive/);
  assert.match(
    lines[1],
    /Showing 0 most recent of 0 total · done 0 · failed 0 · timedout 0 · turns 0 · budget 0 · 0 tok total · span —$/,
  );
  assert.equal(lines[2], "No runs match.");
  assert.equal(lines.length, 3);
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
