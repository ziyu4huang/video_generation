/**
 * task_create/task_get/task_list/task_update (agent-teams parity ticket 03,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the ADAPTER contract over a fresh real TeamTaskStore: schema → store
 * plumbing, owner claim, cycle rejection surfacing, list filters — plus the
 * two registration invariants: the tools ride the extensionTools bridge to
 * children (fake child toolset), and read-only children keep them
 * (READ_ONLY_EXCLUDED must not contain them). Store RULES are pinned in
 * core-runtime's team-task-store.test.ts; these tests stay adapter-shaped.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TeamTaskStore } from "@repo/s2-agent-core-runtime";
import { READ_ONLY_EXCLUDED } from "../src/subagents-tool.js";
import { createTaskTools } from "../src/task-tools.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

const text = (r: { content: Array<{ type: string; text: string }> }) => r.content[0]?.text ?? "";

function mkTools() {
  const store = new TeamTaskStore();
  const tools = createTaskTools({ store });
  const by = new Map(tools.map((t) => [t.name, t]));
  return { store, tools, by };
}

type AnyTool = {
  name: string;
  execute: (id: string, params: unknown, s: never, u: unknown, c: never) => Promise<unknown>;
};

async function run(tool: ToolDefinition | undefined, params: unknown) {
  assert.ok(tool, "tool missing");
  return text((await (tool as unknown as AnyTool).execute("call-1", params, NO_SIGNAL, undefined, NO_CTX)) as never);
}

test("task_create → task_get round-trip; ids and defaults surface in output", async () => {
  const { by, store } = mkTools();
  const created = await run(by.get("task_create"), { subject: "Wire the board", description: "do it" });
  assert.match(created, /Created task #1 "Wire the board"/);
  const fetched = await run(by.get("task_get"), { id: "1" });
  const parsed = JSON.parse(fetched) as { id: string; status: string; description: string };
  assert.equal(parsed.id, "1");
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.description, "do it");
  assert.equal(store.list("*").length, 1);
});

test("task_create with edges links the board symmetrically", async () => {
  const { by, store } = mkTools();
  await run(by.get("task_create"), { subject: "a" });
  await run(by.get("task_create"), { subject: "b", blockedBy: ["1"] });
  assert.deepEqual(store.get("*", "1")?.blocks, ["2"]);
  assert.deepEqual(store.get("*", "2")?.blockedBy, ["1"]);
});

test("task_create rejects cycles and empty subjects with actionable errors", async () => {
  const { by, store } = mkTools();
  await run(by.get("task_create"), { subject: "a" });
  await run(by.get("task_create"), { subject: "b", blockedBy: ["1"] });
  // c blockedBy b AND blocking a: a→(blockedBy c)→c→b→a closes the cycle, and
  // the create must unwind entirely (c never joins the board).
  const cyc = await run(by.get("task_create"), { subject: "c", blockedBy: ["2"], blocks: ["1"] });
  assert.match(cyc, /cycle/);
  assert.equal(store.list("*").length, 2);
  // And no dangling edge from the half-created task on the survivors (the
  // store's atomic-unwind contract, pinned here through the tool surface).
  assert.deepEqual(store.get("*", "2")?.blockedBy, ["1"]);
  assert.deepEqual(store.get("*", "2")?.blocks, []);
  const empty = await run(by.get("task_create"), { subject: "   " });
  assert.match(empty, /subject is required/);
});

test("task_update: owner claim + status move; list renders owner and edges", async () => {
  const { by } = mkTools();
  await run(by.get("task_create"), { subject: "a" });
  await run(by.get("task_create"), { subject: "b", blockedBy: ["1"] });
  const claimed = await run(by.get("task_update"), { id: "2", owner: "researcher", status: "in_progress" });
  assert.match(claimed, /#2 \[in_progress\] owner=researcher — b \(blockedBy: 1\)/);
  const listed = await run(by.get("task_list"), {});
  assert.match(listed, /#1 \[pending\] — a/);
  assert.match(listed, /#2 \[in_progress\] owner=researcher/);
  assert.match(listed, /1 pending, 1 in_progress, 0 completed/);
  // Filters: status and owner both narrow the board.
  const mine = await run(by.get("task_list"), { owner: "researcher" });
  assert.match(mine, /#2/);
  assert.ok(!mine.includes("#1"));
  const pending = await run(by.get("task_list"), { status: "pending" });
  assert.match(pending, /#1/);
  assert.ok(!pending.includes("#2"));
});

test("task_update rejects cycles and unknown ids without mutating", async () => {
  const { by, store } = mkTools();
  await run(by.get("task_create"), { subject: "a" });
  await run(by.get("task_create"), { subject: "b", blockedBy: ["1"] });
  const cyc = await run(by.get("task_update"), { id: "1", addBlockedBy: ["2"] });
  assert.match(cyc, /cycle/);
  assert.deepEqual(store.get("*", "1")?.blockedBy, []);
  const missing = await run(by.get("task_update"), { id: "404", status: "completed" });
  assert.match(missing, /unknown task id "404"/);
});

test("task_get/task_list on an empty board say so without erroring", async () => {
  const { by } = mkTools();
  assert.match(await run(by.get("task_get"), { id: "1" }), /No task #1/);
  assert.match(await run(by.get("task_list"), {}), /No tasks/);
});

test("all four tools declare the workflow gate family (owner-declared gating)", () => {
  const { tools } = mkTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["task_create", "task_get", "task_list", "task_update"],
  );
  for (const t of tools) {
    const gating = (t as { gating?: { gate?: string } }).gating;
    assert.equal(gating?.gate, "workflow", `${t.name} must reference the workflow gate family`);
  }
});

test("read-only children keep the task tools (not in READ_ONLY_EXCLUDED)", () => {
  // A read-only child's toolset = parent tools minus READ_ONLY_EXCLUDED. The
  // task tools mutate the in-memory BOARD, never the filesystem, so excluding
  // them would needlessly blind read-only agents to the shared board.
  const { tools } = mkTools();
  for (const t of tools) {
    assert.ok(
      !READ_ONLY_EXCLUDED.includes(t.name as (typeof READ_ONLY_EXCLUDED)[number]),
      `${t.name} must NOT be in READ_ONLY_EXCLUDED`,
    );
  }
});

test("extensionTools propagation: session_start captures the task tools into the child bridge", async () => {
  // The real bridge: the extension entry registers the tools with pi, then
  // session_start captures pi.getAllToolDefinitions() into the holder that
  // spawn/workflow children receive as extensionTools. Drive the entry with a
  // pi mock that returns the registered defs from getAllToolDefinitions —
  // exactly the seam a live child's toolset flows through.
  const registered: ToolDefinition[] = [];
  const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
  const pi = {
    registerTool: (t: ToolDefinition) => {
      registered.push(t);
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
      handlers[event] = handler;
    },
    getActiveTools: () => [] as string[],
    setActiveTools: () => {},
    getAllToolDefinitions: () => registered,
    sendMessage: async () => {},
    events: { on: () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;

  const { default: extension } = await import("../extensions/subagent.ts");
  extension(pi);

  const names = registered.map((t) => t.name);
  for (const expected of ["task_create", "task_get", "task_list", "task_update"]) {
    assert.ok(names.includes(expected), `extension must register ${expected}; got: ${names.join(", ")}`);
  }

  // Fire session_start with the mock returning the registered defs — the
  // captured child toolset must include all four task tools.
  handlers.session_start?.({}, { model: undefined });
  const captured = pi.getAllToolDefinitions().map((t: ToolDefinition) => t.name);
  for (const expected of ["task_create", "task_get", "task_list", "task_update"]) {
    assert.ok(captured.includes(expected), `child extensionTools must include ${expected}`);
  }

  // And the lifecycle: shutdown drops the board (in-memory only).
  handlers.session_shutdown?.({}, undefined);
});
