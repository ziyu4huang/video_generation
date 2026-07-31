/**
 * Integration test for the capacity → offload-superseded → DB-sync loop (D2+D4).
 *
 * When a store.add() overflows the char limit and the injected provider reports
 * superseded entries for the target, the store purges those superseded entries
 * from `.md` AND the caller must delete their DB rows (destructive, no audit —
 * the existing `syncEvictions`/`removeExactSyncedMemories` content-key path).
 *
 * This test drives the full loop through `applyReviewOperations` (the same
 * operation path the memory-tool / review handlers use) and asserts the
 * superseded DB row is GONE while the active keeper survives.
 *
 * Fixture mirrors tests/handlers/correction-detector.test.ts:233-331 (temp dir
 * → SqliteBackend → SqliteMemoryRepository → MemoryStore).
 *
 * Calibration note: the plan suggested memoryCharLimit: 80, but with the real
 * ENTRY_DELIMITER ("\n§\n", 4 chars) + ~44-char per-entry metadata suffix
 * (` <!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->`), two encoded entries already
 * total 149 chars (> 80). 160 is the minimum limit where (a) the two seed
 * entries fit (149 ≤ 160), (b) the third add overflows (223 > 160), and
 * (c) after purging the superseded entry the keeper + new entry fit (146 ≤ 160)
 * — which is exactly the D2 happy path that surfaces `offloaded_superseded`.
 * (The plan's `.repeat(20)` overflow content is dropped: 440+ chars can never
 * fit post-purge, so it would skip the happy path and never surface
 * `offloaded_superseded`, defeating the DB-sync assertion entirely.)
 */

import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { applyReviewOperations } from "../../src/handlers/review-memory-ops.js";

const PROJECT = "sync-proj";
const ACTIVE_CONTENT = "active keeper syncprobe yyy";
const PRIOR_CONTENT = "superseded doomed syncprobe yyy";
const NEW_CONTENT = "new overflow syncprobe zzz";

describe("overflow add → offload superseded → sync DB (D2 + D4 destructive)", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-sync-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    // See calibration note above: 160 is the minimum viable limit.
    store = new MemoryStore({
      memoryCharLimit: 160,
      userCharLimit: 160,
      projectCharLimit: 160,
      memoryDir: tmpDir,
    } as unknown as ConstructorParameters<typeof MemoryStore>[0]);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overflow add offloads a superseded entry and deletes its DB row (D2 + D4 destructive)", async () => {
    // Seed the `.md` source of truth (store.add) AND the DB mirror
    // (repo.addMemory) with an active keeper + a prior entry, then supersede the
    // prior in the DB. The `.md` has no status column, so both entries remain in
    // `.md`; only the DB knows prior is superseded.
    await store.add("memory", ACTIVE_CONTENT);
    await store.add("memory", PRIOR_CONTENT);

    const active = await repo.addMemory({
      target: "memory",
      project: PROJECT,
      content: ACTIVE_CONTENT,
      category: "insight",
      failureReason: null,
      toolState: null,
      correctedTo: null,
    });
    const prior = await repo.addMemory({
      target: "memory",
      project: PROJECT,
      content: PRIOR_CONTENT,
      category: "insight",
      failureReason: null,
      toolState: null,
      correctedTo: null,
    });
    await repo.supersedeMemory(prior.id, active.id);

    // Wire the provider exactly the way src/index.ts will (Step 3): query the DB
    // for superseded contents for the target/project, return content strings.
    store.setSupersededContentProvider(async (t) => {
      const list = await repo.getMemories({ target: t, project: PROJECT, status: "superseded" });
      return list.map((m) => m.content);
    });

    // Drive an overflow add through the operation path that syncs evictions.
    const result = await applyReviewOperations(
      store,
      null,
      [
        {
          target: "memory",
          action: "add",
          content: NEW_CONTENT,
        },
      ],
      repo,
      PROJECT,
    );

    assert.ok(result.appliedCount >= 1, "the overflow add should be applied, not skipped");

    // The superseded entry's DB row must be deleted (D4: destructive, no audit row).
    const remaining = await repo.getMemories({ project: PROJECT });
    assert.ok(
      !remaining.some((m) => m.content.includes(PRIOR_CONTENT)),
      "superseded DB row should be deleted after offload-sync",
    );
    // The active keeper survives (in both DB and `.md`).
    assert.ok(
      remaining.some((m) => m.content.includes(ACTIVE_CONTENT)),
      "active keeper DB row should survive the overflow offload",
    );
    const mdEntries = store.getMemoryEntries();
    assert.ok(
      mdEntries.some((e) => e.includes(ACTIVE_CONTENT)),
      "active keeper should survive in .md",
    );
    assert.ok(
      !mdEntries.some((e) => e.includes(PRIOR_CONTENT)),
      "superseded entry should be purged from .md",
    );
  });
});
