import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSubagentRunPersistence,
  generateSubagentRunId,
  type SubagentRunRecord,
  subagentRunsDir,
} from "../src/subagent-run-persistence.js";

/** A minimal valid record, with overridable fields. */
function makeRecord(over: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    id: generateSubagentRunId(),
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    task: "do the thing",
    model: "provider/model",
    cwd: "/repo",
    status: "done",
    exitCode: 0,
    timedOut: false,
    startedAt: new Date().toISOString(),
    elapsedMs: 1234,
    output: "all done",
    ...over,
  };
}

/** Fresh temp home per test (real fs; no env mutation → no cross-file races). */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "subagent-persist-"));
}

test("save then load round-trips the full record (incl. history transcript)", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  const history = [
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: '{"path":"x"}' },
    { role: "tool" as const, kind: "toolResult" as const, toolName: "read", text: "ok" },
  ];
  const rec = makeRecord({
    history,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 },
  });
  p.save(rec);
  const loaded = p.load(rec.id);
  assert.deepEqual(loaded, rec);
  rmSync(home, { recursive: true, force: true });
});

test("save writes one JSON file under ~/.pi/subagents/runs with no .tmp left behind (atomic)", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  p.save(makeRecord({ id: "abc123" }));
  const dir = subagentRunsDir(home);
  const files = readdirSync(dir);
  assert.deepEqual(files, ["abc123.json"], "exactly one file, named <id>.json, no .tmp remnant");
  rmSync(home, { recursive: true, force: true });
});

test("list returns runs newest-first (by startedAt)", async () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  p.save(makeRecord({ id: "old", startedAt: "2026-01-01T00:00:00.000Z" }));
  await new Promise((r) => setTimeout(r, 5));
  p.save(makeRecord({ id: "new", startedAt: new Date().toISOString() }));
  const ids = p.list().map((r) => r.id);
  assert.deepEqual(ids, ["new", "old"]);
  rmSync(home, { recursive: true, force: true });
});

test("last-N retention evicts the oldest runs beyond the cap", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home, maxRuns: 2 });
  // Insert in OLDEST→NEWEST order so eviction always removes the earliest.
  for (let i = 0; i < 4; i++) {
    p.save(makeRecord({ id: `r${i}`, startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() }));
  }
  const ids = p.list().map((r) => r.id);
  assert.deepEqual(ids, ["r3", "r2"], "only the 2 newest survive; r0/r1 evicted");
  assert.ok(!p.load("r0"), "evicted run is gone from disk");
  rmSync(home, { recursive: true, force: true });
});

test("delete removes a run and returns false when absent", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  p.save(makeRecord({ id: "gone" }));
  assert.equal(p.delete("gone"), true);
  assert.equal(p.load("gone"), null);
  assert.equal(p.delete("gone"), false, "already deleted → false");
  rmSync(home, { recursive: true, force: true });
});

test("list skips corrupt JSON files (resilient to a half-written neighbor)", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  p.save(makeRecord({ id: "good" }));
  // Hand-write a corrupt neighbor directly into the runs dir.
  writeFileSync(join(subagentRunsDir(home), "broken.json"), "{not json");
  const ids = p.list().map((r) => r.id);
  assert.deepEqual(ids, ["good"], "corrupt file is skipped, valid one survives");
  rmSync(home, { recursive: true, force: true });
});

test("save is best-effort: a fs error never throws (the run result is sacred)", () => {
  const p = createSubagentRunPersistence({
    home: tmpHome(),
    fsOverride: {
      // Simulate a disk write failure on every code path save() tries.
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    },
  });
  assert.doesNotThrow(() => p.save(makeRecord()));
});

test("getRunsDir resolves under the injected home", () => {
  const p = createSubagentRunPersistence({ home: "/tmp/fake-home-xyz" });
  assert.equal(p.getRunsDir(), join("/tmp/fake-home-xyz", ".pi/subagents/runs"));
});

test("turns exhaustion round-trips through save/load and list (status 'turns')", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  const rec = makeRecord({
    id: "turnsrec",
    status: "turns",
    exitCode: 124,
    output: "",
    turns: { maxTurns: 5, turnsUsed: 5 },
  });
  p.save(rec);
  const loaded = p.load("turnsrec");
  assert.deepEqual(loaded?.turns, { maxTurns: 5, turnsUsed: 5 });
  assert.equal(loaded?.status, "turns");
  assert.deepEqual(p.list().find((r) => r.id === "turnsrec")?.turns, { maxTurns: 5, turnsUsed: 5 });
  rmSync(home, { recursive: true, force: true });
});

test("a legacy record without `turns` still parses (optional field, no migration)", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  // Hand-write a pre-#1336 record (no `turns` key) directly into the runs dir.
  mkdirSync(subagentRunsDir(home), { recursive: true });
  const legacy = makeRecord();
  delete (legacy as Partial<SubagentRunRecord>).turns; // makeRecord never sets it, but be explicit
  writeFileSync(join(subagentRunsDir(home), "legacy.json"), JSON.stringify(legacy));
  const loaded = p.load("legacy");
  assert.ok(loaded, "legacy record parses");
  assert.equal(loaded.turns, undefined, "no turns field fabricated for a pre-maxTurns record");
  assert.equal(loaded.status, "done");
  rmSync(home, { recursive: true, force: true });
});

test("round-trips a record carrying a watchdog result", () => {
  const home = tmpHome();
  const p = createSubagentRunPersistence({ home });
  const rec = makeRecord({
    history: [
      { role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: '{"path":"x"}' },
      { role: "tool" as const, kind: "toolResult" as const, toolName: "read", text: "ok" },
    ],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 },
    watchdog: {
      ran: true,
      editGated: false,
      elapsedMs: 3,
      summary: "watchdog: 1 blocker(s), 0 concern(s)",
      l1: {
        ran: true,
        findings: [{ severity: "blocker", source: "lsp", path: "a.ts", line: 1, message: "x" }],
      },
      l2: { ran: false, findings: [] },
    },
  });
  p.save(rec);
  const got = p.list().find((r) => r.watchdog);
  assert.ok(got?.watchdog);
  assert.equal(got.watchdog.l1.findings.length, 1);
  rmSync(home, { recursive: true, force: true });
});
