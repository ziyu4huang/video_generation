/**
 * wakeup-persistence.ts (cc-parity-task ticket 03): session-store snapshot
 * round-trip + the PR #2030 re-anchor rules (future dueAt honored; stale
 * fixed re-anchors a full interval; stale dynamic re-anchors to NOW; expired
 * / unreschedulable entries dropped). Mirrors ext-task's retired
 * loop-persistence tests. No live session, no LLM.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  loadWakeupEntries,
  persistWakeupEntries,
  reanchorWakeupEntries,
  WAKEUP_STATE_ENTRY_TYPE,
} from "../src/wakeup-persistence.js";
import type { WakeupEntry } from "../src/wakeup-registry.js";

const T0 = Date.parse("2026-08-28T12:00:00Z");
const DAY = 86_400_000;

function entry(over: Partial<WakeupEntry> & Pick<WakeupEntry, "id">): WakeupEntry {
  return { prompt: "p", mode: "fixed", dueAt: T0 + 60_000, fireCount: 1, startedAt: T0, ...over };
}

function fakeApi() {
  const calls: Array<{ customType: string; data: unknown }> = [];
  return {
    api: { appendEntry: (customType: string, data: unknown) => calls.push({ customType, data }) },
    calls,
  };
}

test("persist appends a snapshot under the entry type; load round-trips the last one", () => {
  const { api, calls } = fakeApi();
  const entries = [entry({ id: "loop-1", delaySeconds: 300 }), entry({ id: "loop-2", mode: "dynamic" })];
  persistWakeupEntries(api, entries);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.customType, WAKEUP_STATE_ENTRY_TYPE);

  const sm = { getBranch: () => [{ type: "custom", customType: WAKEUP_STATE_ENTRY_TYPE, data: calls[0]!.data }] };
  const loaded = loadWakeupEntries(sm);
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded, entries);
});

test("load ignores old ext-task loop-state entries and non-array payloads", () => {
  const sm = {
    getBranch: () => [
      { type: "custom", customType: "loop-state", data: { loop: { id: "x" } } },
      { type: "custom", customType: WAKEUP_STATE_ENTRY_TYPE, data: { entries: "not-an-array" } },
    ],
  };
  assert.deepEqual(loadWakeupEntries(sm), []);
  assert.deepEqual(loadWakeupEntries(undefined), []);
});

test("load filters malformed entries out of a mixed array", () => {
  const good = entry({ id: "loop-1", delaySeconds: 300 });
  const sm = {
    getBranch: () => [
      {
        type: "custom",
        customType: WAKEUP_STATE_ENTRY_TYPE,
        data: { entries: [good, { id: 7 }, { prompt: "no id" }, null] },
      },
    ],
  };
  assert.deepEqual(loadWakeupEntries(sm), [good]);
});

test("reanchor: a future dueAt is honored verbatim (PR #2030 restart-cadence rule)", () => {
  const future = entry({ id: "loop-1", delaySeconds: 300, dueAt: T0 + 120_000 });
  const out = reanchorWakeupEntries([future], new Date(T0));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dueAt, T0 + 120_000);
});

test("reanchor: a stale fixed entry re-anchors a full interval from NOW (no burst fire)", () => {
  const stale = entry({ id: "loop-1", delaySeconds: 300, dueAt: T0 - DAY });
  const out = reanchorWakeupEntries([stale], new Date(T0));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dueAt, T0 + 300_000);
});

test("reanchor: a stale dynamic entry re-anchors to NOW (fires on the next tick)", () => {
  const stale = entry({ id: "loop-1", mode: "dynamic", dueAt: T0 - DAY });
  const out = reanchorWakeupEntries([stale], new Date(T0));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dueAt, T0);
});

test("reanchor: expired (7d) and unreschedulable (fixed, no delaySeconds) entries are dropped", () => {
  const expired = entry({ id: "loop-1", delaySeconds: 300, startedAt: T0 - 8 * DAY, dueAt: T0 + 60_000 });
  const noDelay = entry({ id: "loop-2", delaySeconds: undefined, dueAt: T0 - 1000 });
  const out = reanchorWakeupEntries([expired, noDelay], new Date(T0));
  assert.deepEqual(out, []);
});
