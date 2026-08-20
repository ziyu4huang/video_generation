import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend";
import { getColumnNames } from "../../src/store/sqlite/corruption-recovery";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { rmSync } from "node:fs";

describe("md_id schema", () => {
  let dir: string;
  beforeEach(() => { dir = join(tmpdir(), `mdid-${Date.now()}-${Math.random()}`); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("SQLite: md_id column exists and is nullable; UNIQUE permits multiple NULLs", async () => {
    const backend = new SqliteBackend(dir); await backend.init();
    const repo = new SqliteMemoryRepository(backend);
    // Two rows, no md_id yet — both NULL must coexist under the UNIQUE index.
    await repo.addMemory({ target: "memory", project: null, content: "a", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await repo.addMemory({ target: "memory", project: null, content: "b", created: "2026-08-01", lastReferenced: "2026-08-01" });
    const cols = getColumnNames(backend["db"], "memories");
    expect(cols.has("md_id")).toBe(true);
    expect(await repo.getMdIdByContent("a", { target: "memory" })).toBeNull();
  });

  // Un-skipped 2026-08-18. The stated reason — "`setMdIdByContent` is added in
  // Task 4, not this task" — expired when Task 4 shipped it on both backends,
  // but the skip stayed. Running it then failed on the FIRST assertion: the
  // return was 9, not 1, because bun:sqlite's `.changes` counts the rows the
  // FTS5 triggers touch (see sqlite-memory-repo.setMdIdByContent). The UNIQUE
  // index itself was fine all along. So this file's skip was hiding a real
  // count bug rather than a missing feature.
  test("SQLite: md_id is unique among non-NULL values", async () => {
    const backend = new SqliteBackend(dir); await backend.init();
    const repo = new SqliteMemoryRepository(backend);
    await repo.addMemory({ target: "memory", project: null, content: "a", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await expect(repo.setMdIdByContent("a", "dup", { target: "memory" })).resolves.toBe(1);
    await repo.addMemory({ target: "memory", project: null, content: "b", created: "2026-08-01", lastReferenced: "2026-08-01" });
    await expect(repo.setMdIdByContent("b", "dup", { target: "memory" })).rejects.toThrow();
  });
});
