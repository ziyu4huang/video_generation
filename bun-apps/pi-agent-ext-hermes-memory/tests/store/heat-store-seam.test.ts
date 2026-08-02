/**
 * Store-level seam tests for the heat-provider injection (UPSP §1 decay,
 * ticket #1b, Task 3).
 *
 * `MemoryStore` gains `setHeatForEntriesProvider` + a protected `computeHeats`
 * helper (mirroring `setSupersededContentProvider` / `setStableIdBackfillProvider`).
 * This file exercises the seam in isolation — T4/T6 exercise real consumption.
 *
 * `computeHeats` is `protected`, so a thin test subclass exposes it. The
 * subclass delegates to `super.computeHeats`, which reads the instance's
 * injected provider (set via the inherited `setHeatForEntriesProvider`).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { MemoryStore, type HeatEntryInput } from "../../src/store/memory-store.js";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

let MEMORY_DIR = "";

// Test subclass exposing the protected computeHeats helper.
class ExposedStore extends MemoryStore {
  public computeHeatsExposed(
    target: "memory" | "user" | "failure",
    entries: HeatEntryInput[],
  ): Promise<Map<string, number> | null> {
    return this.computeHeats(target, entries);
  }
}

function makeStore(): ExposedStore {
  return new ExposedStore({
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    memoryDir: MEMORY_DIR,
  } as MemoryConfig);
}

function entry(mdId: string): HeatEntryInput {
  return { mdId, lastReferenced: "2024-01-01", created: "2024-01-01" };
}

describe("MemoryStore heat-provider seam (setHeatForEntriesProvider + computeHeats)", () => {
  beforeAll(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-heat-seam-"));
  });
  afterAll(async () => {
    try { await fs.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("computeHeats returns null when no provider is attached", async () => {
    const store = makeStore();
    const result = await store.computeHeatsExposed("memory", [entry("a"), entry("b")]);
    assert.equal(result, null, "absent provider → null (T4/T5 fall back to FIFO)");
  });

  it("computeHeats returns the provider's Map when set + non-empty", async () => {
    const store = makeStore();
    const fixed = new Map([["a", 0.9], ["b", 0.1]]);
    store.setHeatForEntriesProvider(async () => fixed);
    const result = await store.computeHeatsExposed("memory", [entry("a"), entry("b")]);
    assert.notEqual(result, null);
    assert.equal(result!.get("a"), 0.9);
    assert.equal(result!.get("b"), 0.1);
  });

  it("computeHeats passes the target through to the provider", async () => {
    const store = makeStore();
    let seenTarget: string | null = null;
    store.setHeatForEntriesProvider(async (target) => {
      seenTarget = target;
      return new Map([["a", 0.5]]);
    });
    await store.computeHeatsExposed("failure", [entry("a")]);
    assert.equal(seenTarget, "failure");
  });

  it("computeHeats returns null when the provider throws (best-effort)", async () => {
    const store = makeStore();
    store.setHeatForEntriesProvider(async () => {
      throw new Error("boom");
    });
    const result = await store.computeHeatsExposed("memory", [entry("a")]);
    assert.equal(result, null, "a throwing provider must not crash eviction → null");
  });

  it("computeHeats returns null when the provider returns an empty Map (its own best-effort)", async () => {
    const store = makeStore();
    store.setHeatForEntriesProvider(async () => new Map());
    const result = await store.computeHeatsExposed("memory", [entry("a")]);
    assert.equal(result, null, "empty Map == no usable heat → null (FIFO fallback)");
  });

  it("computeHeats returns null for empty entries (even with a provider set)", async () => {
    const store = makeStore();
    let called = false;
    store.setHeatForEntriesProvider(async () => {
      called = true;
      return new Map([["x", 1]]);
    });
    const result = await store.computeHeatsExposed("memory", []);
    assert.equal(result, null);
    assert.equal(called, false, "the provider must not be invoked for empty entries");
  });
});
