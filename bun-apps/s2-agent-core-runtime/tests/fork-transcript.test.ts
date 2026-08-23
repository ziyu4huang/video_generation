/**
 * Fork transcript projection (cc-parity-2 ticket 02 — pure function contract:
 * compaction-aware projection, text-only turns, char cap with oldest-first
 * truncation, and the ambient fork-child scope backing the no-fork-recursion
 * guard). No session needed — fixtures are raw SessionEntry trees.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildForkTranscript,
  FORK_TRANSCRIPT_HEADER,
  isForkChild,
  projectTranscriptTurns,
  runAsForkChild,
} from "../src/fork-transcript.js";

const TS = "2026-08-23T00:00:00.000Z";

/** Message entry fixture. Content is a bare string or a content-item array. */
function msg(id: string, parentId: string | null, role: string, content: unknown): SessionEntry {
  return { type: "message", id, parentId, timestamp: TS, message: { role, content } as never } as SessionEntry;
}

function compaction(id: string, parentId: string, firstKeptEntryId: string, summary: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TS,
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
  } as SessionEntry;
}

test("projects user/assistant text in order; tool calls, tool results, and custom entries are dropped", () => {
  const entries: SessionEntry[] = [
    msg("e1", null, "user", "please audit the file"),
    msg("e2", "e1", "assistant", [
      { type: "text", text: "reading the file now" },
      { type: "toolCall", id: "tc1", arguments: { path: "a.ts" } },
    ]),
    msg("e3", "e2", "toolResult", [{ type: "text", text: "tool output noise" }]),
    msg("e4", "e3", "assistant", [{ type: "thinking", text: "internal reasoning" }]),
    msg("e5", "e4", "user", [
      { type: "text", text: "second ask" },
      { type: "image", data: "..." },
    ]),
    { type: "custom", id: "e6", parentId: "e5", timestamp: TS, customType: "noise", data: {} } as SessionEntry,
    msg("e7", "e6", "assistant", "final answer"),
  ];
  const turns = projectTranscriptTurns(entries, "e7");
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(turns[0]?.text, "please audit the file");
  assert.equal(turns[1]?.text, "reading the file now");
  assert.equal(turns[2]?.text, "second ask");
  assert.equal(turns[3]?.text, "final answer");
});

test("compaction is respected: pre-compaction turns omitted, summary + kept tail included", () => {
  const entries: SessionEntry[] = [
    msg("e1", null, "user", "old ask one"),
    msg("e2", "e1", "assistant", "old answer"),
    compaction("c1", "e2", "e3", "we discussed the audit and fixed two files"),
    msg("e3", "c1", "user", "kept ask"),
    msg("e4", "e3", "assistant", "kept answer"),
  ];
  const turns = projectTranscriptTurns(entries, "e4");
  assert.deepEqual(
    turns.map((t) => t.role),
    ["compactionSummary", "user", "assistant"],
  );
  assert.match(turns[0]?.text ?? "", /we discussed the audit/);
  assert.equal(turns[1]?.text, "kept ask");

  const block = buildForkTranscript(entries, "e4");
  assert.ok(block);
  assert.ok(block.startsWith(FORK_TRANSCRIPT_HEADER));
  assert.ok(!block.includes("old ask one"), "pre-compaction turns do not reach the fork child");
  assert.match(block, /Summary of earlier turns/);
});

test("empty / textless conversation renders undefined (fork of an empty session)", () => {
  assert.deepEqual(projectTranscriptTurns([], null), []);
  assert.equal(buildForkTranscript([], null), undefined);
  const onlyToolNoise = [msg("e1", null, "toolResult", [{ type: "text", text: "noise" }])];
  assert.equal(buildForkTranscript(onlyToolNoise, "e1"), undefined);
});

test("cap truncates OLDEST-first with the marker; newest turns survive under the cap", () => {
  const entries: SessionEntry[] = [
    msg("e1", null, "user", "A".repeat(40)),
    msg("e2", "e1", "assistant", "B".repeat(40)),
    msg("e3", "e2", "user", "C".repeat(40)),
    msg("e4", "e3", "assistant", "the newest turn must survive"),
  ];
  const cap = 100;
  const block = buildForkTranscript(entries, "e4", cap);
  assert.ok(block);
  const body = block.slice(FORK_TRANSCRIPT_HEADER.length + 2);
  assert.ok(body.startsWith("[... earlier turns truncated ...]"), "marker names the dropped turns");
  assert.ok(!block.includes("AAAA"), "oldest turn dropped");
  assert.ok(block.includes("the newest turn must survive"));
  // Hard bound: header + marker + body never exceeds cap + header + marker overhead.
  assert.ok(block.length <= cap + FORK_TRANSCRIPT_HEADER.length + 80, `block length ${block.length} near cap`);
});

test("a single over-cap turn is sliced — the cap is a hard bound, not advisory", () => {
  const entries = [msg("e1", null, "user", "X".repeat(500))];
  const block = buildForkTranscript(entries, "e1", 100);
  assert.ok(block);
  assert.ok(block.length <= 100 + FORK_TRANSCRIPT_HEADER.length + 80);
  assert.ok(!block.includes("truncated"), "a single turn drops nothing, it is sliced");
});

test("runAsForkChild scopes isForkChild() across awaits; the guard is false outside", async () => {
  assert.equal(isForkChild(), false);
  const inside = runAsForkChild(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    return isForkChild();
  });
  assert.equal(await inside, true, "the scope propagates through awaits/timers");
  assert.equal(isForkChild(), false, "outside the fork run the guard is inert");
  // A grandchild spawned (asynchronously) from inside the scope inherits it.
  const grandchild = runAsForkChild(async () => {
    await (async () => await Promise.resolve())();
    return isForkChild();
  });
  assert.equal(await grandchild, true);
});
