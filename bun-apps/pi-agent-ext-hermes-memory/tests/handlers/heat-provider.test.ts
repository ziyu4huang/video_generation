/**
 * Unit tests for the heat-provider builder (UPSP §1 decay, ticket #1b, Task 3).
 *
 * `makeHeatProvider` builds the closure that crosses MemoryStore's DB-free
 * boundary: it batches `mw_*` (memoryRepo) + `used_at` (sessionRepo) and calls
 * `computeHeat` per entry. Tested in isolation with stub repos — no real DB.
 *
 * Determinism: the provider uses `new Date()` internally for `now`, so entry
 * dates are built relative to the test's own `new Date()` (today / N-days-ago)
 * to keep relative ages stable regardless of wall-clock drift.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { makeHeatProvider, shouldWireHeat } from "../../src/handlers/heat-provider.js";
import type { HeatEntryInput } from "../../src/store/memory-store.js";
import type { MemoryEntry, MemoryTarget } from "../../src/store/repository.js";

// ─── Date helpers (relative to "now" so heat is deterministic) ───

const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

// ─── Stub repo builders ───

interface StubMemoryRepo {
  getMemories: (opts: { target?: MemoryTarget; project?: string | null }) => Promise<MemoryEntry[]>;
  calls: { target?: MemoryTarget; project?: string | null }[];
}
interface StubSessionRepo {
  getUsedMdIds: (mdIds: string[], opts: { project: string | null }) => Promise<Set<string>>;
  calls: { mdIds: string[]; project: string | null }[];
}

/** Stub memoryRepo whose getMemories returns the given rows (filtered to the
 *  asked mdIds is the PROVIDER's job, not the repo's — the stub returns all). */
function stubMemoryRepo(rows: MemoryEntry[]): StubMemoryRepo {
  const calls: { target?: MemoryTarget; project?: string | null }[] = [];
  return {
    calls,
    getMemories: async (opts) => {
      calls.push({ ...opts });
      return rows;
    },
  };
}

/** Stub sessionRepo whose getUsedMdIds returns the given used mdId set. */
function stubSessionRepo(used: Set<string>): StubSessionRepo {
  const calls: { mdIds: string[]; project: string | null }[] = [];
  return {
    calls,
    getUsedMdIds: async (mdIds, opts) => {
      calls.push({ mdIds: [...mdIds], project: opts.project });
      return new Set([...used].filter((id) => mdIds.includes(id)));
    },
  };
}

/** Build a MemoryEntry-shaped row with just the heat-relevant fields. */
function row(mdId: string, mwSuccess: number, mwFail: number): MemoryEntry {
  return {
    id: 0,
    project: null,
    target: "memory",
    category: null,
    content: "",
    failureReason: null,
    toolState: null,
    correctedTo: null,
    created: "1970-01-01",
    lastReferenced: "1970-01-01",
    mwSuccess,
    mwFail,
    mdId,
  };
}

function entry(mdId: string, ageDays: number): HeatEntryInput {
  const date = daysAgo(ageDays);
  return { mdId, lastReferenced: date, created: date };
}

describe("makeHeatProvider", () => {
  it("a used + recent + high-worth entry scores higher than unused + stale + low-worth", async () => {
    const hot = entry("hot", 3); // 3 days old
    const cold = entry("cold", 30); // 30 days old
    const provider = makeHeatProvider(
      {},
      {
        memoryRepo: stubMemoryRepo([row("hot", 10, 0), row("cold", 0, 10)]),
        sessionRepo: stubSessionRepo(new Set(["hot"])), // only "hot" was ever used
      },
      null,
    );
    const heats = await provider("memory", [hot, cold]);
    assert.ok(heats.get("hot")! > heats.get("cold")!, `hot (${heats.get("hot")}) should outrank cold (${heats.get("cold")})`);
    // Sanity: hot is high (recent + worth + used), cold is low (stale + low-worth + unused).
    assert.ok(heats.get("hot")! > 0.5, `hot should be > 0.5, got ${heats.get("hot")}`);
    assert.ok(heats.get("cold")! < 0.5, `cold should be < 0.5, got ${heats.get("cold")}`);
  });

  it("an entry with no DB row (mw 0/0) gets neutral Laplace — heat reflects recency only", async () => {
    // Two same-recency, unused entries: one has a DB row (mw 0/0), one has none.
    // Both → laplace 0.5 → worthMult 1.0 → heat == recencySpine (identical).
    const withRow = entry("db", 5);
    const noRow = entry("legacy", 5);
    const memoryRepo = stubMemoryRepo([row("db", 0, 0)]); // "legacy" absent
    const provider = makeHeatProvider(
      {},
      { memoryRepo, sessionRepo: stubSessionRepo(new Set()) },
      null,
    );
    const heats = await provider("memory", [withRow, noRow]);
    assert.ok(
      Math.abs(heats.get("db")! - heats.get("legacy")!) < 1e-9,
      `no-row entry should match neutral mw 0/0 row: db=${heats.get("db")} legacy=${heats.get("legacy")}`,
    );
    // And recency still drives: a recent no-row entry beats a stale no-row entry.
    const recent = entry("r", 1);
    const stale = entry("s", 60);
    const heats2 = await provider("memory", [recent, stale]);
    assert.ok(heats2.get("r")! > heats2.get("s")!, `recent no-row (${heats2.get("r")}) should beat stale no-row (${heats2.get("s")})`);
  });

  it("calls sessionRepo.getUsedMdIds with the right mdIds + project", async () => {
    const sessionRepo = stubSessionRepo(new Set());
    const memoryRepo = stubMemoryRepo([]);
    const provider = makeHeatProvider({}, { memoryRepo, sessionRepo }, "proj-x");
    await provider("memory", [entry("a", 1), entry("b", 2), entry("c", 3)]);
    assert.equal(sessionRepo.calls.length, 1);
    assert.deepEqual(sessionRepo.calls[0]!.mdIds.sort(), ["a", "b", "c"]);
    assert.equal(sessionRepo.calls[0]!.project, "proj-x");
    // memoryRepo scoped to the same target + project.
    assert.equal(memoryRepo.calls.length, 1);
    assert.equal(memoryRepo.calls[0]!.target, "memory");
    assert.equal(memoryRepo.calls[0]!.project, "proj-x");
  });

  it("a throwing memoryRepo → empty Map (no throw escapes)", async () => {
    const throwingMemory: StubMemoryRepo = {
      calls: [],
      getMemories: async () => {
        throw new Error("db down");
      },
    };
    const provider = makeHeatProvider(
      {},
      { memoryRepo: throwingMemory, sessionRepo: stubSessionRepo(new Set()) },
      null,
    );
    const heats = await provider("memory", [entry("a", 1)]);
    assert.equal(heats.size, 0, "a throwing repo must yield an empty Map");
  });

  it("a throwing sessionRepo → empty Map (no throw escapes)", async () => {
    const throwingSession: StubSessionRepo = {
      calls: [],
      getUsedMdIds: async () => {
        throw new Error("db down");
      },
    };
    const provider = makeHeatProvider(
      {},
      { memoryRepo: stubMemoryRepo([row("a", 1, 0)]), sessionRepo: throwingSession },
      null,
    );
    const heats = await provider("memory", [entry("a", 1)]);
    assert.equal(heats.size, 0, "a throwing sessionRepo must yield an empty Map");
  });

  it("empty entries → empty Map and NO repo calls", async () => {
    const memoryRepo = stubMemoryRepo([]);
    const sessionRepo = stubSessionRepo(new Set());
    const provider = makeHeatProvider({}, { memoryRepo, sessionRepo }, null);
    const heats = await provider("memory", []);
    assert.equal(heats.size, 0);
    assert.equal(memoryRepo.calls.length, 0, "getMemories must not be called for empty entries");
    assert.equal(sessionRepo.calls.length, 0, "getUsedMdIds must not be called for empty entries");
  });

  it("uses each mdId only once (first row wins; duplicate DB rows do not double-count)", async () => {
    // A duplicated mdId in the DB (shouldn't happen, but be defensive) must not
    // error or skew the result — the provider keeps the first worth triple.
    const provider = makeHeatProvider(
      {},
      {
        memoryRepo: stubMemoryRepo([row("a", 5, 0), row("a", 0, 5)]),
        sessionRepo: stubSessionRepo(new Set()),
      },
      null,
    );
    const heats = await provider("memory", [entry("a", 1)]);
    assert.equal(heats.size, 1);
    assert.ok(heats.has("a"));
  });
});

describe("shouldWireHeat (disable-path gate)", () => {
  it("defaults to true (decay on) when decayEnabled is absent", () => {
    assert.equal(shouldWireHeat({}), true);
  });

  it("is true when decayEnabled is explicitly true", () => {
    assert.equal(shouldWireHeat({ decayEnabled: true }), true);
  });

  it("is false ONLY when decayEnabled is explicitly false (the disable invariant)", () => {
    assert.equal(shouldWireHeat({ decayEnabled: false }), false);
  });
});
