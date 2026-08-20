/**
 * Integration test for the capacity → offload-superseded → DB-sync loop (D2+D4).
 *
 * When a store.add() overflows the char limit and the injected provider reports
 * superseded entries for the target, the store purges those superseded entries
 * from `.md` AND the caller must delete their DB rows (destructive, no audit —
 * the steady-state card-store eviction mirror (kp13 Wave C: deleteCard by
 * md_id), ticket 04).
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
import { createCardStore } from "../../src/store/card-store.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";

const PROJECT = "sync-proj";
const ACTIVE_CONTENT = "active keeper syncprobe yyy";
const PRIOR_CONTENT = "superseded doomed syncprobe yyy";
const NEW_CONTENT = "new overflow syncprobe zzz";

// Stable md_ids mirrored onto both the `.md` frontmatter and the DB rows so the
// md_id-keyed purge/sync (ticket 04) can match across the `.md`↔DB seam.
const ACTIVE_MD_ID = "active-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PRIOR_MD_ID = "prior-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Build a frontmatter-shaped `.md` entry (post-backfill shape) with a stable id. */
function fm(mdId: string, body: string): string {
  return `---\nid: ${mdId}\ncreated: 2026-08-01\nlast: 2026-08-01\n---\n${body}`;
}

/** Write frontmatter entries to the memory `.md` file (seeds the on-disk source
 *  of truth; `_addInner` reloads from disk so array injection would be wiped). */
async function seedMd(store: MemoryStore, entries: string[]): Promise<void> {
  const dir = (store as unknown as { memoryDir: string }).memoryDir;
  await fs.promises.writeFile(path.join(dir, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
}

// ─── Resurrect-stale guard (Task 4) ─────────────────────────────────────────
// Unique nonce carried ONLY by the superseded entry. The guard asserts this
// nonce is never resurrected into recall after an overflow + consolidation
// cycle — i.e. offload-superseded-first purges it BEFORE the consolidator sees
// its content.
const GUARD_NONCE = "resurrectguard qqxnv";
const GUARD_ACTIVE_ONE = "active keeper alpha axa";
const GUARD_ACTIVE_TWO = "active keeper bravo bxb";
const GUARD_SUPERSEDED = `stale ${GUARD_NONCE}`;
// NEW is sized LARGE (≈91-char body) so that even after purging the superseded
// entry, [A1,A2]+NEW still overflows the limit → the consolidator MUST run
// (frontmatter seeds are ~114 chars each, so a small NEW would let the purge
// early-return fire and skip consolidation entirely).
const GUARD_NEW = "new overflow nu nxn payload segment " + "z".repeat(56);
// Stable md_ids for the guard fixtures (mirrored on `.md` frontmatter + DB).
const GUARD_A1_MD_ID = "a1aaaaaa-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GUARD_A2_MD_ID = "a2aaaaaa-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GUARD_SUP_MD_ID = "supaaaaa-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// Calibration (frontmatter seeds, ticket 05 shape; computed via the real
//   encodeEntry + ENTRY_DELIMITER "\n§\n"):
//   3 frontmatter seeds total 351 chars; the 4th add totals 490 (>limit →
//   overflow); after purging the superseded entry, [A1,A2]+N totals 370
//   (>limit → the consolidator MUST run, not the purge early-return); the 2→1
//   merge of the active keepers' STRIPPED bodies (getMemoryEntries strips
//   frontmatter) saves ~190 chars so the retry fits (233 ≤ limit).
//   360 is chosen inside the valid window [351,370): the three seeds fit
//   (351 ≤ 360) so seeding never trips overflow; after purge [A1,A2]+N is still
//   370 > 360 → the consolidator runs on the superseded-free remainder.
const GUARD_LIMIT = 360;

// Minimal in-process consolidator stub: merges ALL current `.md` entries for
// the target into ONE content-preserving entry (joined with " | "). Unlike the
// real LLM consolidator (which summarizes), this stub preserves verbatim text —
// so if a superseded entry survived into `.md`, its nonce is resurrected into
// the merge. This is exactly the D0/D2 hazard the guard locks. Uses internal
// helpers (setEntries/saveToDisk/encodeEntry) the same way the production
// consolidator rewrites the file on disk; saveToDisk does not re-acquire the
// file lock (it only writes), so it is safe to call from inside the held lock.
// (2-phase note: this helper now returns a MergePlan that MERGES every seeded
// entry into one content-preserving row; the store applies it in step 3. The
// drop-everything-else semantics are identical to the old direct-mutate stub.)
function installMergingConsolidator(store: MemoryStore): void {
  store.setConsolidator(async (snapshot) => {
    // Merge every entry into ONE content-preserving row (joined with " | ").
    // Unlike the real LLM consolidator (which summarizes), this stub preserves
    // verbatim text — so if a superseded entry survived into the snapshot, its
    // nonce is resurrected into the merge. That is exactly the D0/D2 hazard the
    // guard locks (the snapshot is taken AFTER the superseded purge, so it is
    // absent and cannot be resurrected).
    const keys = snapshot.entries.map((e) => e.key);
    const merged = snapshot.entries.map((e) => e.content).join(" | ");
    return {
      plan: {
        snapshotBaseHash: snapshot.snapshotBaseHash,
        ops: keys.length
          ? [{ op: "merge" as const, fromKeys: keys, content: merged }]
          : [],
      },
    };
  }, "merge-stub");
}

describe("overflow add → offload superseded → sync DB (D2 + D4 destructive)", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-sync-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    // Calibration (frontmatter seeds, ticket 05 shape): two ~120-char
    // frontmatter entries total ~241; the NEW add overflows at ~315; after
    // purging the superseded entry [ACTIVE]+NEW is ~232 ≤ 250 → the purge
    // early-return fires (the D2 happy path that surfaces offloaded_superseded).
    // (Task 7 raised 220→250: births emit a ~86-char frontmatter header, so
    // [ACTIVE, NEW] must stay under the limit post-purge for the early return.)
    store = new MemoryStore({
      memoryCharLimit: 250,
      userCharLimit: 250,
      projectCharLimit: 250,
      memoryDir: tmpDir,
    } as unknown as ConstructorParameters<typeof MemoryStore>[0]);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overflow add offloads a superseded entry and deletes its DB row (D2 + D4 destructive)", async () => {
    // Seed the `.md` source of truth with FRONTMATTER entries (post-backfill
    // shape, stable ids) AND the DB mirror with matching md_ids, then supersede
    // the prior in the DB. The `.md` has no status column, so both entries
    // remain in `.md`; only the DB knows prior is superseded.
    await seedMd(store, [fm(ACTIVE_MD_ID, ACTIVE_CONTENT), fm(PRIOR_MD_ID, PRIOR_CONTENT)]);

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
    // Mirror the stable ids onto the DB rows so removeByMdId can match (ticket 04).
    await repo.setMdIdByContent(ACTIVE_CONTENT, ACTIVE_MD_ID, { target: "memory", project: PROJECT });
    await repo.setMdIdByContent(PRIOR_CONTENT, PRIOR_MD_ID, { target: "memory", project: PROJECT });
    await repo.supersedeMemory(prior.id, active.id);

    // Wire the provider exactly the way src/index.ts does: query the DB for
    // superseded rows for the target/project, return their MD_IDS.
    store.setSupersededContentProvider(async (t) => {
      const list = await repo.getMemories({ target: t, project: PROJECT, status: "superseded" });
      return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
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
      PROJECT,
      await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend }),
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

// ─── Task 4: resurrect-stale guard ────────────────────────────────────────────
//
// Locks the D0/D2 promise: a superseded entry is NEVER recalled by
// consolidation. Drives a REAL consolidation-capable overflow (two active
// keepers + one superseded; limit tuned so purge-first does NOT free enough —
// the consolidator must run). The two core absence assertions are on the
// superseded nonce (GUARD_NONCE): (a) absent from the `.md` the consolidator
// read/merged, and (b) absent from DB recall. A third assertion — the active
// keeper survives — isolates the status filter (catches Mutation B: getMemories
// ignoring status would purge the active keeper too).
describe("resurrect-stale guard: superseded never consolidated into recall", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resurrect-guard-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    store = new MemoryStore({
      memoryCharLimit: GUARD_LIMIT,
      userCharLimit: GUARD_LIMIT,
      projectCharLimit: GUARD_LIMIT,
      memoryDir: tmpDir,
      // Non-reject strategy so the consolidator runs on all-active overflow.
      memoryOverflowStrategy: "auto-consolidate",
    } as unknown as ConstructorParameters<typeof MemoryStore>[0]);
    installMergingConsolidator(store);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a superseded entry is purged before consolidation and never recalled", async () => {
    // Seed `.md` with FRONTMATTER entries (stable ids) AND the DB mirror with
    // matching md_ids, then supersede the prior in the DB. The `.md` has no
    // status column, so all three remain in `.md`; only the DB knows the prior
    // is superseded.
    await seedMd(store, [
      fm(GUARD_A1_MD_ID, GUARD_ACTIVE_ONE),
      fm(GUARD_A2_MD_ID, GUARD_ACTIVE_TWO),
      fm(GUARD_SUP_MD_ID, GUARD_SUPERSEDED),
    ]);

    const a1 = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_ACTIVE_ONE, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    const a2 = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_ACTIVE_TWO, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    const sup = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_SUPERSEDED, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    await repo.setMdIdByContent(GUARD_ACTIVE_ONE, GUARD_A1_MD_ID, { target: "memory", project: PROJECT });
    await repo.setMdIdByContent(GUARD_ACTIVE_TWO, GUARD_A2_MD_ID, { target: "memory", project: PROJECT });
    await repo.setMdIdByContent(GUARD_SUPERSEDED, GUARD_SUP_MD_ID, { target: "memory", project: PROJECT });
    await repo.supersedeMemory(sup.id, a1.id);
    // Sanity: a2 stays active too.
    assert.ok((await repo.getMemories({ project: PROJECT, status: "active" })).some((m) => m.id === a2.id));

    // Wire the provider exactly as src/index.ts does: return MD_IDS of the
    // superseded rows for the target/project.
    store.setSupersededContentProvider(async (t) => {
      const list = await repo.getMemories({ target: t, project: PROJECT, status: "superseded" });
      return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
    });

    // Drive the overflow add through the operation path that syncs evictions.
    // The new add tips an already-full store over the limit; purge-first removes
    // the superseded entry, but the two active keepers + new add still exceed
    // the limit, so the consolidator runs on the (superseded-free) remainder.
    const result = await applyReviewOperations(
      store,
      null,
      [{ target: "memory", action: "add", content: GUARD_NEW }],
      PROJECT,
      await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend }),
    );
    assert.ok(result.appliedCount >= 1, "the overflow add should be applied, not skipped");

    const mdEntries = store.getMemoryEntries();
    // (a) CORE: the superseded nonce is ABSENT from the `.md` the consolidator
    //     read/merged — proves purge-first ran BEFORE consolidation saw it.
    assert.ok(
      !mdEntries.some((e) => e.includes(GUARD_NONCE)),
      "superseded nonce must be purged from .md before consolidation (no resurrection)",
    );
    // (b) CORE: the superseded nonce is ABSENT from DB recall.
    const recalled = await repo.searchMemories(GUARD_NONCE, { project: PROJECT });
    assert.ok(
      !recalled.some((m) => m.content.includes(GUARD_NONCE)),
      "superseded nonce must not be recalled via searchMemories",
    );
    // (c) ISOLATION: the active keeper survives — locks the status filter so a
    //     broken getMemories (returns active+superseded) cannot silently purge
    //     the active keeper along with the superseded one.
    assert.ok(
      mdEntries.some((e) => e.includes(GUARD_ACTIVE_ONE)),
      "active keeper must survive the purge (status filter isolates superseded)",
    );
  });
});

// ─── Task 2 fix round 1: orphan-DB-row regression on the FLOOR path ───────────
//
// Locks the D4 destructive guarantee on the NON-happy overflow path: when the
// provider purges a superseded entry from `.md` but the store is STILL over
// limit (so it falls through to the vault-offload FLOOR, NOT the purge
// early-return), the purged-superseded set must still reach the caller's
// syncEvictions — else the `.md` row is gone but the DB row lingers as an orphan.
//
// Pre-fix: vaultOffloadAndAdd returned {evicted_entries,...} with NO
// offloaded_superseded, so applyReviewOperations' syncEvictions(...,offloaded_superseded)
// was a no-op → the superseded DB row survived → RED. Post-fix (A): the floor
// attaches offloaded_superseded → the row is deleted → GREEN. The same field-
// threading also covers the REJECT path (B's reject branch) and the recursion
// accumulator (B) covers the consolidation-success path; this test pins the
// floor because it is the simplest deterministic driver (no consolidator).
describe("overflow floor: superseded DB row is not orphaned after vault-offload", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-orphan-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    // Same calibration window as the resurrect-stale guard (GUARD_LIMIT=217):
    // 3 seeds fit (213 ≤ 217); the 4th add overflows (296 > 217); AFTER purging
    // the superseded entry [A1,A2]+N is still 222 > 217 → falls through to the
    // FLOOR. No consolidator is installed, so the floor (vaultOffloadAndAdd) is
    // reached directly — the exact path 1 from the finding.
    store = new MemoryStore({
      memoryCharLimit: GUARD_LIMIT,
      userCharLimit: GUARD_LIMIT,
      projectCharLimit: GUARD_LIMIT,
      memoryDir: tmpDir,
      memoryOverflowStrategy: "auto-consolidate",
    } as unknown as ConstructorParameters<typeof MemoryStore>[0]);
    // NOTE: deliberately NO installMergingConsolidator — we want the floor, not
    // the consolidation-success recursion (covered by the guard test above).
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes the superseded DB row even when the floor (not early-return) handles overflow", async () => {
    // Seed `.md` with FRONTMATTER entries (stable ids) AND the DB mirror with
    // matching md_ids, then supersede the prior in the DB.
    await seedMd(store, [
      fm(GUARD_A1_MD_ID, GUARD_ACTIVE_ONE),
      fm(GUARD_A2_MD_ID, GUARD_ACTIVE_TWO),
      fm(GUARD_SUP_MD_ID, GUARD_SUPERSEDED),
    ]);

    const a1 = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_ACTIVE_ONE, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    const a2 = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_ACTIVE_TWO, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    const sup = await repo.addMemory({ target: "memory", project: PROJECT, content: GUARD_SUPERSEDED, category: "insight", failureReason: null, toolState: null, correctedTo: null });
    await repo.setMdIdByContent(GUARD_ACTIVE_ONE, GUARD_A1_MD_ID, { target: "memory", project: PROJECT });
    await repo.setMdIdByContent(GUARD_ACTIVE_TWO, GUARD_A2_MD_ID, { target: "memory", project: PROJECT });
    await repo.setMdIdByContent(GUARD_SUPERSEDED, GUARD_SUP_MD_ID, { target: "memory", project: PROJECT });
    await repo.supersedeMemory(sup.id, a1.id);
    assert.ok((await repo.getMemories({ project: PROJECT, status: "active" })).some((m) => m.id === a2.id));

    // Provider wired exactly as src/index.ts does: return MD_IDS of superseded rows.
    store.setSupersededContentProvider(async (t) => {
      const list = await repo.getMemories({ target: t, project: PROJECT, status: "superseded" });
      return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
    });

    // Drive the overflow add. After-purge is still over limit → the FLOOR runs.
    const result = await applyReviewOperations(
      store,
      null,
      [{ target: "memory", action: "add", content: GUARD_NEW }],
      PROJECT,
      await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend }),
    );
    assert.ok(result.appliedCount >= 1, "the overflow add should be applied via the floor, not skipped");
    // (The floor-vs-early-return distinction is guaranteed by calibration:
    // after purging the superseded entry, [A1,A2]+N is still 222 > 217, so the
    // purge early-return cannot fire — the floor must run.)

    // CORE (RED-when-unfixed): the superseded nonce's DB row must be DELETED,
    // not orphaned. Pre-fix the floor returned no offloaded_superseded, so
    // syncEvictions never ran for it and the row survived (getMemories with no
    // status filter returns superseded rows) → this assertion would FAIL.
    // Post-fix (A) the floor attaches offloaded_superseded → row deleted → PASS.
    const remaining = await repo.getMemories({ project: PROJECT });
    assert.ok(
      !remaining.some((m) => m.content.includes(GUARD_NONCE)),
      "superseded DB row must be deleted after the floor (no orphan), not merely hidden by status filter",
    );

    // The superseded entry is also gone from `.md` (the provider purge ran).
    const mdEntries = store.getMemoryEntries();
    assert.ok(
      !mdEntries.some((e) => e.includes(GUARD_NONCE)),
      "superseded entry must be purged from .md",
    );
  });
});
