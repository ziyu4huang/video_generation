import { describe, it, expect } from "bun:test";
import type {
  MemoryRepository, SessionRepository, Backend,
  MemoryEntry, MemorySyncInput,
} from "../../src/store/repository.js";

describe("repository seam (types)", () => {
  it("a minimal object satisfies MemoryRepository", () => {
    const repo: MemoryRepository = {
      async addMemory() { return {} as MemoryEntry; },
      async syncMemoryEntry(_input: MemorySyncInput) { return { action: "inserted", entry: {} as MemoryEntry }; },
      async syncMemoryEntriesBatch(inputs: MemorySyncInput[]) { return inputs.map(() => ({ action: "inserted" as const, entry: {} as MemoryEntry })); },
      async replaceSyncedMemories() { return { matched: 0, updated: 0, entries: [] }; },
      async removeSyncedMemories() { return { matched: 0, removed: 0 }; },
      async removeExactSyncedMemories() { return { matched: 0, removed: 0 }; },
      async removeByMdId() { return { matched: 0, removed: 0 }; },
      async searchMemories() { return []; },
      async getMemories() { return []; },
      async getRecentFailures() { return []; },
      async getMemoryStats() { return { total: 0, byProject: [], byTarget: [] }; },
      async removeMemory() { return false; },
      async touchMemory() { return; },
    };
    expect(typeof repo.searchMemories).toBe("function");
  });

  it("Backend has init/close/healthCheck only", () => {
    const backend: Backend = {
      async init() { return; },
      async close() { return; },
      async healthCheck() { return; },
    };
    expect(typeof backend.init).toBe("function");
  });
});
