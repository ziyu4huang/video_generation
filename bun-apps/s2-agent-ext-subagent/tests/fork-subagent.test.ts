/**
 * Fork dispatches (`spawn_subagent` `fork: true` — cc-parity-2 ticket 02).
 *
 * Pins the tool-level contract: pre-flight rejections (`name`, `agentType`,
 * fork recursion, missing transcript source), background-by-default, the
 * transcript block's composition position (FIRST in instructions, ahead of the
 * agent-prompt; task keeps env-hints + abort-safety ordering untouched), and
 * that non-fork dispatches are byte-for-byte unaffected.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { runAsForkChild, type SpawnSubagentOptions, type SpawnSubagentResult } from "@repo/s2-agent-core-runtime";
import { BackgroundRunManager } from "../src/background-run-manager.js";
import { createSubagentTool } from "../src/subagent-tool.js";
import { ok } from "./_spawn-result.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

const TRANSCRIPT_BLOCK = [
  "## Parent conversation (context only, do not continue it)",
  "",
  "user: earlier ask",
  "",
  "assistant: earlier answer",
].join("\n");

/** Records spawn opts; resolves done. */
function fakeSpawn(result: () => SpawnSubagentResult = () => ok("fork output")) {
  const calls: SpawnSubagentOptions[] = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions) => {
      calls.push(opts);
      return result();
    },
  };
}

function mkTool(overrides: Record<string, unknown> = {}) {
  const f = fakeSpawn();
  const tool = createSubagentTool({
    cwd: "/repo",
    spawn: f.spawn,
    getParentTranscript: () => TRANSCRIPT_BLOCK,
    ...overrides,
  } as never);
  return { tool, calls: f.calls };
}

test("`fork` + `name` fails pre-flight — nothing spawned", async () => {
  const { tool, calls } = mkTool();
  const res = await tool.execute("c-fn", { task: "t", fork: true, name: "forked" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /`fork` \+ `name`/);
  assert.equal(calls.length, 0);
});

test("`fork` + `agentType` fails pre-flight (forks are untyped)", async () => {
  const { tool, calls } = mkTool();
  const res = await tool.execute(
    "c-ft",
    { task: "t", fork: true, agentType: "reviewer" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /`fork` \+ `agentType`/);
  assert.equal(calls.length, 0);
});

test("a fork child cannot fork again (ambient scope guard)", async () => {
  const { tool, calls } = mkTool();
  const res = await runAsForkChild(() =>
    tool.execute("c-rec", { task: "t", fork: true }, NO_SIGNAL, undefined, NO_CTX),
  );
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /cannot fork from a fork child/);
  assert.equal(calls.length, 0);
});

test("`fork` without a transcript source fails pre-flight — never a silent empty inheritance", async () => {
  const f = fakeSpawn();
  const tool = createSubagentTool({ cwd: "/repo", spawn: f.spawn } as never); // no getParentTranscript
  const res = await tool.execute("c-notx", { task: "t", fork: true }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /no parent-session transcript source/);
  assert.equal(f.calls.length, 0);
});

test("fork is background by default (immediate 'running' return; transcript composed first)", async () => {
  const manager = new BackgroundRunManager();
  const { tool, calls } = mkTool({ background: manager });
  const res = await tool.execute("c-bg", { task: "fork work", fork: true }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "running");
  assert.match((res.content[0] as { text: string }).text, /dispatched → background/);
  // The run continues in-process; pump (macrotasks — the default git baseline
  // capture spawns a real git subprocess that microtask ticks cannot clear).
  for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(calls.length, 1);
  const opts = calls[0];
  assert.ok(opts.instructions, "fork dispatch carries instructions");
  assert.ok(
    (opts.instructions as string).startsWith("## Parent conversation"),
    "transcript block composes FIRST in instructions",
  );
  assert.ok(!(opts.instructions as string).includes("undefined"));
  for (let i = 0; i < 200 && manager.runningIds().length > 0; i++) await new Promise((r) => setTimeout(r, 1));
});

test("explicit background:false runs a fork foreground with the transcript block", async () => {
  const { tool, calls } = mkTool();
  const res = await tool.execute(
    "c-fg",
    { task: "foreground fork", fork: true, background: false, agent: "auditor" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "done");
  assert.equal(calls.length, 1);
  const instructions = calls[0].instructions as string;
  const blockEnd = instructions.indexOf("auditor");
  assert.ok(blockEnd > 0, "agent-prompt present");
  assert.ok(
    instructions.indexOf("## Parent conversation") < instructions.indexOf("You are the auditor"),
    "transcript block precedes the agent-prompt",
  );
  // The task itself keeps its own composition: the raw prompt is untouched by
  // the transcript (env-hints/footer ordering lives on the task, not here).
  assert.equal(calls[0].task.includes("## Parent conversation"), false);
});

test("non-fork dispatches are unchanged: no transcript, no instructions when no agent prompt", async () => {
  const { tool, calls } = mkTool();
  const res = await tool.execute("c-plain", { task: "plain task" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].instructions, undefined);
});
