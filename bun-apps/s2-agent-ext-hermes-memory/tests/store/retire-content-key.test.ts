/**
 * Task 5 — Retire the content-key bridge (full replace), Option B (split fields).
 *
 * Locks the md_id-based matching that replaces the content-key bridge in steady
 * state. The eviction/transfer `*_entries` fields stay CONTENT (archive +
 * display consumers); parallel `*_md_ids` fields carry the stable frontmatter
 * ids for DB-sync. `offloaded_superseded` is md_id-only (no archive/display
 * consumer — destructive). `purgeSupersededFromMarkdown` now matches by
 * frontmatter `id`, not stripped content.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const TODAY = "2026-08-01";

function frontmatter(id: string, body: string): string {
  return `---\nid: ${id}\ncreated: ${TODAY}\nlast: ${TODAY}\n---\n${body}`;
}

const DIRS: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-ck-"));
  DIRS.push(dir);
  return dir;
}
afterEach(() => {
  while (DIRS.length) {
    const d = DIRS.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function internals(store: MemoryStore): {
  memoryEntries: string[];
  purgeSupersededFromMarkdown: (t: "memory" | "user" | "failure", ids: string[]) => Promise<string[]>;
} {
  return store as unknown as ReturnType<typeof internals>;
}

describe("retire content-key bridge", () => {
  test("purgeSupersededFromMarkdown matches by md_id, not content", async () => {
    const dir = freshDir();
    const store = new MemoryStore({ memoryDir: dir, memoryCharLimit: 10000, userCharLimit: 10000 } as MemoryConfig);
    const TARGET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const SUPER_ID = "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee";
    internals(store).memoryEntries = [
      frontmatter(TARGET_ID, "keep me"),
      frontmatter(SUPER_ID, "evict me"),
    ];
    const purged = await internals(store).purgeSupersededFromMarkdown("memory", [SUPER_ID]);
    expect(purged).toEqual([SUPER_ID]);
    expect(internals(store).memoryEntries.length).toBe(1);
    expect(internals(store).memoryEntries[0]).toContain(TARGET_ID);
  });

  test("purgeSupersededFromMarkdown skips comment entries (no frontmatter id)", async () => {
    const dir = freshDir();
    const store = new MemoryStore({ memoryDir: dir, memoryCharLimit: 10000, userCharLimit: 10000 } as MemoryConfig);
    internals(store).memoryEntries = [
      "comment entry no id <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const purged = await internals(store).purgeSupersededFromMarkdown("memory", ["some-md-id"]);
    expect(purged).toEqual([]);
    expect(internals(store).memoryEntries.length).toBe(1);
  });

  test("vault-offload emits BOTH evicted_entries (content) and evicted_md_ids", async () => {
    const dir = freshDir();
    const store = new MemoryStore({
      memoryDir: dir,
      memoryCharLimit: 250,
      userCharLimit: 10000,
      memoryOverflowStrategy: "auto-consolidate",
    } as MemoryConfig);
    const KEEP_ID = "11111111-1111-1111-1111-111111111111";
    const EVICT_ID = "22222222-2222-2222-2222-222222222222";
    // _addInner reloads from disk — write frontmatter entries to the file.
    fs.writeFileSync(
      path.join(dir, MEMORY_FILE),
      [frontmatter(EVICT_ID, "old entry retireprobe offload"), frontmatter(KEEP_ID, "keep retireprobe")].join(ENTRY_DELIMITER),
      "utf-8",
    );
    // No consolidator wired → auto-consolidate falls straight to the vault floor.
    const result = await store.add("memory", "new entry fits retireprobe");
    expect(result.success).toBe(true);
    // content field stays (archive + display consumer).
    expect(result.evicted_entries).toEqual(["old entry retireprobe offload"]);
    // md_id field added (DB-sync consumer).
    expect(result.evicted_md_ids).toEqual([EVICT_ID]);
  });

  test("transfer emits BOTH transferred_entries (content) and transferred_md_ids", async () => {
    const dir = freshDir();
    const store = new MemoryStore({
      memoryDir: dir,
      memoryCharLimit: 10000,
      userCharLimit: 10000,
    } as MemoryConfig);
    const A_ID = "33333333-3333-3333-3333-333333333333";
    const B_ID = "44444444-4444-4444-4444-444444444444";
    // transferEntries reloads from disk — write frontmatter entries to the file.
    fs.writeFileSync(
      path.join(dir, MEMORY_FILE),
      [frontmatter(A_ID, "alpha transferprobe"), frontmatter(B_ID, "bravo transferprobe")].join(ENTRY_DELIMITER),
      "utf-8",
    );
    const result = await store.transferEntries("memory", "transferprobe");
    expect(result.success).toBe(true);
    // content stays for the archive (writeTransferArchive) + display.
    expect(result.transferred_entries).toEqual(["alpha transferprobe", "bravo transferprobe"]);
    // md_ids added for DB-sync.
    expect(result.transferred_md_ids).toEqual([A_ID, B_ID]);
  });
});
