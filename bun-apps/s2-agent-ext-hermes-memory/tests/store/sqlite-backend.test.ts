/**
 * Direct lifecycle test for the sqlite backend via the createSqliteBackend
 * factory (ticket 08 — audit + fill).
 *
 * The 2026-08-16 audit found the lifecycle cell almost fully covered
 * elsewhere: schema idempotency, FTS5 bootstrap, close semantics, WAL, FK and
 * byte-level corruption recovery all live in db.test.ts (driving SqliteBackend
 * directly); the factory happy path lives in backend-factory.test.ts. The one
 * uncovered sub-cell was SqliteBackend.healthCheck() — the PRAGMA quick_check
 * probe — which had zero direct coverage (repository.test.ts only mocks the
 * Backend interface). This suite covers it, with the factory-path lifecycle
 * (init idempotent, close-twice safe) riding along as the minimum scaffolding.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteBackend } from "../../src/store/backend-factory.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";

describe("SqliteBackend lifecycle via createSqliteBackend", () => {
  let dir: string;
  let backend: SqliteBackend;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-sqlite-backend-"));
    backend = await createSqliteBackend(dir); // new SqliteBackend(dir) + init()
  });

  afterEach(async () => {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("init() is idempotent and healthCheck() resolves on a healthy file DB", async () => {
    await expect(backend.init()).resolves.toBeUndefined(); // idempotent re-run
    await expect(backend.healthCheck()).resolves.toBeUndefined(); // PRAGMA quick_check → ok
  });

  it("close() is safe to call again after a first close (current behavior)", async () => {
    await backend.close();
    await expect(backend.close()).resolves.toBeUndefined();
  });
});
