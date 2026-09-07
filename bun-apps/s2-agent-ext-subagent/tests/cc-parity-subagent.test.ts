/**
 * CC-parity subagent samples — executable mirrors of the COMMON patterns in
 * Claude Code's official sub-agents doc (code.claude.com/docs/en/sub-agents,
 * section "Common patterns", plus the canonical code-reviewer example).
 *
 * Each test is NAMED after the documented pattern it proves:
 *   A1 "Isolate high-volume operations"  — verbose work stays child-side; the
 *      parent-facing surface carries only the child's compact final message.
 *   A2 "Run parallel research"           — batch fan-out of read-only research
 *      tasks; positional results return in input order.
 *   A3 "Chain subagents"                 — result plumbing: spawn #1's output is
 *      embedded into spawn #2's task (the model-driven behavior itself is
 *      receipted live by the tui-drive `cc-parity` scenario, self-arc-12 t04).
 *   A4 code-reviewer                     — a read-only reviewer definition
 *      surfaces findings without mutating the reviewed file (sha256-pinned).
 *
 * Unit level = the `fakeSpawn` seam (tests record the opts they were called
 * with) + the `_spawn-result.ts` builders; no LLM in these gates. The batch
 * tool's ALWAYS-read-only constraint (edit/write/bash excluded, non-
 * overridable) shapes every task design here — see READ_ONLY_EXCLUDED.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentDefinition,
  AgentRegistry,
  SpawnSubagentOptions,
  SubagentRunPersistence,
} from "@repo/s2-agent-core-runtime";
import { createSubagentTool as realCreateSubagentTool } from "../src/subagent-tool.js";
import type { SubagentToolOptions } from "../src/subagent-tool-schema.js";
import { createSubagentsTool, READ_ONLY_EXCLUDED } from "../src/subagents-tool.js";
import { ok } from "./_spawn-result.js";

// Same no-snapshot seam as subagent-tool.test.ts: default startup-context
// capture would run real git and make the spawned task nondeterministic.
const noSnapshotOps = { snapshot: async () => undefined } as never;
const createSubagentTool = (o: SubagentToolOptions = {}) =>
  realCreateSubagentTool({ gitSnapshotOps: noSnapshotOps, ...o });

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;
const FIXTURES = join(import.meta.dir, "fixtures", "cc-parity");

/** Injectable spawn that records the opts it was called with. */
function fakeSpawn(impl: (opts: SpawnSubagentOptions) => Promise<{ output: string }>) {
  const calls: SpawnSubagentOptions[] = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions) => {
      calls.push(opts);
      return impl(opts);
    },
  };
}

/** Index-keyed spawn for parallel fan-outs. */
function fakeSpawnByIndex(outputs: string[]) {
  const calls: SpawnSubagentOptions[] = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions) => {
      const i = calls.length;
      calls.push(opts);
      return ok(outputs[i] ?? "MISSING");
    },
  };
}

/** Persistence stub capturing save() calls (A1's durable-record seam). */
function fakePersistence() {
  const saved: Array<{ output: string; status: string }> = [];
  return {
    saved,
    persistence: {
      save: (r: { output: string; status: string }) => saved.push(r),
      list: () => [],
    } as never as SubagentRunPersistence,
  };
}

function mkRegistry(defs: AgentDefinition[]): AgentRegistry {
  const registry: AgentRegistry = new Map();
  for (const d of defs) registry.set(d.name, d);
  return registry;
}

// ── A1: "Isolate high-volume operations" ────────────────────────────────────
// The doc's pattern: hand a side task whose output would flood the main
// conversation to a subagent; only the summary returns. The structural half
// provable at unit level: the parent-facing result IS the child's final
// message (nothing else crosses the boundary), the durable record captures
// the run, and the child carries the tools it needs to do the heavy reading
// in its own context.
test("A1 isolate high-volume operations: parent surface is the compact summary, heavy reading stays child-side", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn(() => ok("SUMMARY: CC-PARITY-A1 corpus=3 files, longest=webhooks.md (8 retry lines)"));
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  const res = await tool.execute(
    "a1",
    {
      task:
        "Read every file under tests/fixtures/cc-parity/corpus/ IN FULL, then reply with ONE line " +
        "starting 'SUMMARY:'. Do not paste file contents into your reply.",
      tools: ["read", "bash"],
    },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /^SUMMARY: CC-PARITY-A1/, "parent sees the child's compact final message");
  assert.doesNotMatch(text, /Delivery is at-least-once/, "corpus prose never crosses into the parent surface");
  // The child could do the heavy reading itself: read/bash present in its opts.
  assert.deepEqual(f.calls[0]?.tools, ["read", "bash"]);
  // The run is durably recorded (viewer/replay recover it post-session).
  assert.equal(saved.length, 1, "run record persisted");
  assert.equal(saved[0]?.status, "done");
  assert.match(saved[0]?.output ?? "", /SUMMARY: CC-PARITY-A1/);
});

// ── A2: "Run parallel research" ─────────────────────────────────────────────
// The doc's pattern: several independent read-only investigations at once,
// results synthesized by the parent. s2-agent's `subagents` batch tool is the
// fan-out: positional results, read-only enforced (edit/write/bash excluded
// non-overridably — sample tasks are designed read-only, not worked around).
test("A2 run parallel research: 3 read-only corpus probes return positional findings in input order", async () => {
  const findings = [
    "FINDING auth: device flow polls 5s × 12 attempts max",
    "FINDING limits: 120 rpm, burst 20, third 429 → 60s cooldown",
    "FINDING webhooks: at-least-once, 8 retries 1s→15m, then disabled",
  ];
  const f = fakeSpawnByIndex(findings);
  const tool = createSubagentsTool({ cwd: "/repo", spawn: f.spawn as never, gitSnapshotOps: noSnapshotOps });
  const corpus = join(FIXTURES, "corpus");
  const res = await tool.execute(
    "a2",
    {
      tasks: [
        { task: `Read ${corpus}/auth-flow.md and report one FINDING line.` },
        { task: `Read ${corpus}/rate-limits.md and report one FINDING line.` },
        { task: `Read ${corpus}/webhooks.md and report one FINDING line.` },
      ],
    } as never,
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  // Positional completeness: one result per task, in input order.
  const results = (res.details as { results: Array<{ output?: string; status?: string }> }).results;
  assert.equal(results.length, 3);
  for (const [i, finding] of findings.entries()) {
    assert.equal(results[i]?.status, "done");
    assert.match(results[i]?.output ?? "", new RegExp(finding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Read-only enforcement at the spawn seam: every child excludes the
  // tree-mutating trio, non-overridably.
  for (const o of f.calls) {
    for (const t of READ_ONLY_EXCLUDED) {
      assert.ok((o.excludeTools ?? []).includes(t), `child excludes ${t}`);
    }
  }
});

// ── A3: "Chain subagents" ───────────────────────────────────────────────────
// The doc's pattern: a multi-step workflow where one subagent's result feeds
// the next. Unit level proves the RESULT-PLUMBING seam (parent reads spawn
// #1's output and embeds it into spawn #2's task); the model-driven chaining
// behavior is receipted live by the tui-drive `cc-parity` scenario (t04).
test("A3 chain subagents: spawn #1's output token is embedded into spawn #2's task", async () => {
  let n = 0;
  const f = fakeSpawn(() => {
    n++;
    return n === 1 ? ok("TOKEN: cc-parity-a3") : ok("CHAINED-DONE");
  });
  const tool = createSubagentTool({ spawn: f.spawn });

  const first = await tool.execute(
    "a3-1",
    { task: "Compute the handshake token and reply 'TOKEN: <value>'." },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const token = (first.content[0] as { text: string }).text.trim();

  const second = await tool.execute(
    "a3-2",
    { task: `A previous subagent produced this token: "${token}". Verify it and reply CHAINED-DONE.` },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match((second.content[0] as { text: string }).text, /CHAINED-DONE/);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1]?.task ?? "", /cc-parity-a3/, "spawn #2's task carries spawn #1's output");
});

// ── A4: code-reviewer (the doc's canonical example agent) ───────────────────
// The doc's example: a read-only code reviewer (tools exclude Edit/Write).
// Sample: a reviewer definition reviews the planted-bug fixture, surfaces the
// defect, and the reviewed file is byte-unchanged across the review.
test("A4 code-reviewer: read-only reviewer returns findings and leaves the reviewed file byte-unchanged", async () => {
  const target = join(FIXTURES, "planted-bug.ts");
  const sha256 = () => createHash("sha256").update(readFileSync(target)).digest("hex");
  const before = sha256();

  const reviewerDef: AgentDefinition = {
    name: "cc-code-reviewer",
    description: "Read-only code reviewer (CC canonical example).",
    tools: ["read", "grep", "glob"],
    disallowedTools: ["edit", "write"],
    prompt:
      "You are a code reviewer. Examine the given code and report findings as 'FINDING:' lines. You never modify files.",
    source: "builtin",
  };
  const f = fakeSpawn(() => ok("FINDING: off-by-one in sumTo — `i < n` drops the final addend (sumTo(4) = 6, not 10)"));
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: mkRegistry([reviewerDef]),
  });

  const res = await tool.execute(
    "a4",
    { task: `Review ${target} for logic defects.`, agentType: "cc-code-reviewer" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /FINDING: off-by-one/, "reviewer surfaces the planted defect");
  // Reviewer binding at the spawn seam — the definition folds into tools /
  // excludeTools / instructions (there is no agentType field on the spawn
  // opts; resolution happens against the registry before dispatch).
  const opts = f.calls[0];
  assert.deepEqual(opts?.tools, ["read", "grep", "glob"], "reviewer allowlist from the definition");
  for (const t of (opts?.excludeTools ?? []) as string[]) {
    assert.ok(["edit", "write"].includes(t), `reviewer denies ${t}`);
  }
  assert.match(opts?.instructions ?? "", /code reviewer/, "definition prompt binds as role guidance");
  // Belt and braces: the reviewed file is byte-identical after the review.
  assert.equal(sha256(), before, "code-reviewer sample is read-only end to end");
});
