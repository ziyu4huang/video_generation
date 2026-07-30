/**
 * MemoryStore.add — optional category label on user/memory targets.
 * Backs the grill_decision write-target fix: grill captures are user-traits
 * carrying a topical category label, not failure/lesson entries.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, beforeEach, afterEach } from "bun:test";
import * as assert from "node:assert/strict";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("MemoryStore.add — optional category label", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ms-addcat-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prefixes [category] when a category is provided (user target)", async () => {
    const store = new MemoryStore({ memoryDir: dir });
    await store.add("user", "prefers concise answers", { category: "preference" });
    const entries = store.getUserEntries();
    assert.ok(
      entries.some((e) => e.includes("[preference] prefers concise answers")),
      `expected a [preference]-prefixed entry; got ${JSON.stringify(entries)}`,
    );
  });

  it("leaves content bare when no category is given (backward compatible)", async () => {
    const store = new MemoryStore({ memoryDir: dir });
    await store.add("user", "a plain note");
    const entries = store.getUserEntries();
    const entry = entries.find((e) => e.includes("a plain note"));
    assert.ok(entry, "entry should exist");
    assert.ok(!entry.includes("] a plain note"), "no category prefix should be injected");
  });
});
