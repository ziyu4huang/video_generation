/**
 * Task 6 — Id-lifecycle contract (integration). Ticket 03 acceptance gate.
 *
 * Encodes the three legs of the stable-id lifecycle against the REAL store +
 * REAL SqliteBackend/SqliteMemoryRepository in a tmp dir (no mocks of the
 * behavior under test):
 *
 *   • BIRTH        — a consolidated/merged entry is minted a FRESH uuid that is
 *                    neither of the consumed entries' ids.
 *   • IMMUTABLE    — the frontmatter `id` never changes once assigned: through
 *                    supersession (status flip is DB-only) and across repeated
 *                    backfill runs (idempotent).
 *   • DIE TRACELESSLY — OFFLOAD (D2 superseded purge + vault-offload floor)
 *                    deletes the DB row + its md_id TOGETHER (hard `DELETE FROM`,
 *                    no status tombstone); the vault archive carries the retired
 *                    md_id as provenance. CONSOLIDATION-consumed DB rows are an
 *                    EXCEPTION today: the store does NOT route them through the
 *                    md_id seam (ConsolidationResult has no consumed-md_ids
 *                    field); they are cleaned only by the consolidator CHILD's
 *                    content-key path (removeSyncedMemories = `content LIKE`).
 *                    md_id-retire of the child path is a tracked follow-up (see
 *                    plan "Post-merge follow-up"). Scenario 1 documents this
 *                    current reality rather than papering over it.
 *
 * Harness assembled from the real store-test patterns this migration
 * established — `tests/store/{retire-content-key,backfill-stable-ids,
 * md-id-schema}.test.ts` (frontmatter seeding, tmp memoryDir + MemoryStore,
 * SqliteBackend + SqliteMemoryRepository wiring, backfill provider wiring).
 * NOTE: `tests/integration/flow.test.ts` is a cross-module constants/security
 * contract file, NOT a store harness — it is not mirrored here.
 *
 * Architectural note (why the test drives `removeByMdId` explicitly): the
 * `.md`-ground-truth `MemoryStore` does NOT hold a `MemoryRepository` ref — on
 * eviction/offload/transfer it returns the retired md_ids
 * (`evicted_md_ids` / `offloaded_superseded` / `transferred_md_ids`) and the
 * ADAPTER (`src/tools/memory-tool.ts` / `src/handlers/review-memory-ops.ts` →
 * `mirrorMemoryEvictions`) hard-deletes the DB rows via `deleteCard` by
 * md_id. The OFFLOAD scenarios (2a/2b) wire that exact
 * adapter call (the `syncEvictions` helper below is a verbatim mirror of the
 * production loop) so the .md→DB death contract is exercised end-to-end on the
 * real repo. Scenario 1 (consolidation) deliberately does NOT — see its comment.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { createCardStore } from "../../src/store/card-store.js";
import { mirrorMemoryEvictions } from "../../src/store/memory-card-mirror.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import { serializeMetadataFrontmatter } from "../../src/store/memory-format.js";
import type { MemoryConfig } from "../../src/types.js";
import type { MemoryTarget, MemoryRepository } from "../../src/store/repository.js";

const TODAY = "2026-08-01";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── tmp-dir + backend lifecycle ─────────────────────────────────────────
const DIRS: string[] = [];
const BACKENDS: SqliteBackend[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-idlife-"));
  DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (BACKENDS.length) {
    try { BACKENDS.pop()!.close(); } catch { /* ignore */ }
  }
  while (DIRS.length) {
    try { fs.rmSync(DIRS.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── frontmatter helpers (ticket 05 schema) ──────────────────────────────

/** Build a frontmatter entry whose byte form matches `serializeMetadataFrontmatter`. */
function fmEntry(id: string, body: string): string {
  return serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY });
}

/** Legacy comment-shape entry (pre-backfill). */
function commentEntry(body: string): string {
  return `${body} <!-- created=${TODAY}, last=${TODAY} -->`;
}

/** Extract the frontmatter `id` from an entry, or null when comment-shape. */
function frontmatterId(entry: string): string | null {
  if (!entry.startsWith("---\n")) return null;
  const m = entry.match(/^id: (.+)$/m);
  return m ? m[1]! : null;
}

/** Read a target's entries straight from the on-disk ground-truth file. */
function readEntries(dir: string, file: string = MEMORY_FILE): string[] {
  const raw = fs.readFileSync(path.join(dir, file), "utf-8");
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

/** Seed the memory file with N entries (joined by the canonical delimiter). */
function seedMemoryFile(dir: string, entries: string[]): void {
  fs.writeFileSync(path.join(dir, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
}

// ─── adapter mirror: the production steady-state DB-sync (ticket 04) ──────
/**
 * Verbatim mirror of the production eviction adapter (kp13 Wave C:
 * `mirrorEvictions` in src/tools/memory-tool.ts / src/handlers/
 * review-memory-ops.ts — both call `mirrorMemoryEvictions`): for each retired
 * md_id, hard-delete the card row via `deleteCard` (md_id-keyed; ids are
 * globally unique so no target/project scope). The card store is joined on the
 * harness backend (bundle-join style — same `memories` table the repo reads).
 * This is the call the real adapter makes once the store returns the retired
 * md_ids — kept in the test so the full .md→DB traceless-death contract runs
 * against the real store.
 */
async function syncEvictions(
  backend: SqliteBackend,
  dir: string,
  mdIds: string[],
): Promise<void> {
  const cardStore = await createCardStore({ memoryDir: dir, sqliteBackend: backend });
  await mirrorMemoryEvictions(cardStore, mdIds);
}

/** Seed a DB row for `content`, mirror `mdId` onto it (mirrors backfill), and
 *  optionally flip it to `superseded` via a real `supersedeMemory` onto a
 *  replacement row (the faithful way to get status=superseded + md_id intact). */
async function seedDbRow(
  repo: SqliteMemoryRepository,
  content: string,
  mdId: string,
  opts: { target?: MemoryTarget; status?: "active" | "superseded" } = {},
): Promise<number> {
  const target = opts.target ?? "memory";
  const entry = await repo.addMemory({ content, target, project: null, created: TODAY, lastReferenced: TODAY });
  await repo.setMdIdByContent(content, mdId, { target, project: null });
  if (opts.status === "superseded") {
    // A superseded row implies a replacement exists — mint one and flip via the
    // real repo path. md_id on the prior is untouched by supersedeMemory.
    const replacement = await repo.addMemory({ content: content + " §REPL§", target, project: null, created: TODAY, lastReferenced: TODAY });
    await repo.supersedeMemory(entry.id, replacement.id);
  }
  return entry.id;
}

interface Harness {
  dir: string;
  store: MemoryStore;
  backend: SqliteBackend;
  repo: SqliteMemoryRepository;
}

async function setup(config: Partial<MemoryConfig> = {}): Promise<Harness> {
  const dir = freshDir();
  const backend = new SqliteBackend(dir);
  await backend.init();
  BACKENDS.push(backend);
  const repo = new SqliteMemoryRepository(backend);
  const store = new MemoryStore({
    memoryDir: dir,
    memoryCharLimit: 10000,
    userCharLimit: 10000,
    ...config,
  } as MemoryConfig);
  await store.loadFromDisk();
  return { dir, store, backend, repo };
}

// ─── The 4 contract scenarios ────────────────────────────────────────────

describe("id-lifecycle contract (ticket 03)", () => {
  // ── 1. BIRTH + (honest) consolidation-consumed md_id-seam gap ─────────
  //
  // WHAT THIS SCENARIO ASSERTS (and why it does NOT assert md_id-hard-delete):
  // The store's consolidation path (runConsolidator → _addInner recursion) does
  // NOT surface consolidation-CONSUMED md_ids to the caller: ConsolidationResult
  // is { consolidated, error?, terminated? } (NO consumed-md_ids field), and the
  // recursion neither threads consumed ids into evicted_md_ids nor into
  // offloaded_superseded. The successResponse the store ultimately returns
  // carries neither field, so the adapter's add-handler
  // (mirrorMemoryEvictions) syncs an EMPTY md_id set for
  // consolidation-consumed rows.
  // The ONLY production cleanup of consolidation-consumed DB rows is the
  // consolidator CHILD subagent's content-key removes (removeSyncedMemories =
  // `content LIKE`) — OUT of 5d's store-bridge scope; deferred per controller
  // decision 2026-08-01 (see plan "Post-merge follow-up": "Retire content-key
  // from the consolidation CHILD path"). md_id-retire of the child path is a
  // tracked follow-up. Driving that real child path in-process is not reliable
  // (it needs a full agent + LLM), so this scenario instead asserts the store's
  // current, honest behavior: the consumed md_ids are NOT routed through the
  // md_id seam. When the follow-up lands, UPGRADE this scenario to assert
  // md_id-hard-delete via result.evicted_md_ids (flip the survive-assertions to
  // .toBeNull() and require evicted_md_ids to carry the consumed ids).
  test("consolidation: merged entry gets a FRESH uuid; consumed md_ids NOT routed through store md_id seam (child content-key cleanup — tracked follow-up)", async () => {
    const A_ID = "aaaaaaaa-1111-1111-1111-111111111111";
    const B_ID = "bbbbbbbb-2222-2222-2222-222222222222";
    const BODY_A = "alpha consolidation probe one with enough body text to fill the budget aaa";
    const BODY_B = "bravo consolidation probe two with enough body text to fill the budget bbb";
    const MERGED_BODY = "merged consolidation result";

    // memoryCharLimit sized so [A,B] + a new add overflows, but [merged] + the
    // new add fits after consolidation (merged body is deliberately small).
    // Task 7: births emit a ~86-char frontmatter header, so the limit is raised
    // from 210 to 280 to keep [merged, new] under budget post-consolidation.
    const { dir, store, backend, repo } = await setup({
      memoryCharLimit: 280,
      memoryOverflowStrategy: "auto-consolidate",
    });

    seedMemoryFile(dir, [fmEntry(A_ID, BODY_A), fmEntry(B_ID, BODY_B)]);
    await seedDbRow(repo, BODY_A, A_ID);
    await seedDbRow(repo, BODY_B, B_ID);

    // Stub consolidator for determinism: mints a fresh uuid (MERGED_ID) and
    // rewrites MEMORY.md to a single merged frontmatter entry. A real
    // consolidator CHILD is a subagent that issues memory-tool add/replace/remove
    // ops (which also mint a fresh id for the merged entry via `memory add`);
    // the stub stands in for that child so the store's consolidation branch can
    // be driven deterministically in-process — it is NOT a byte-for-byte mirror
    // of the child's tool-call sequence (and issues no memory-tool ops itself).
    const MERGED_ID = globalThis.crypto.randomUUID();
    let consolidatorRan = false;
    store.setConsolidator(async (target) => {
      consolidatorRan = true;
      // Rewrite the .md to a single merged frontmatter entry (fresh id).
      fs.writeFileSync(path.join(dir, MEMORY_FILE), fmEntry(MERGED_ID, MERGED_BODY), "utf-8");
      return { consolidated: true };
    }, "stub");

    // Sanity: the consumed rows are present + md_id-mirrored before consolidation.
    expect(await repo.getMdIdByContent(BODY_A, { target: "memory", project: null })).toBe(A_ID);
    expect(await repo.getMdIdByContent(BODY_B, { target: "memory", project: null })).toBe(B_ID);

    // Force overflow → triggers auto-consolidation.
    const result = await store.add("memory", "new fresh note after consolidation probe");
    expect(result.success).toBe(true);
    expect(consolidatorRan).toBe(true);

    // ── BIRTH: merged entry present in .md with a FRESH uuid ≠ either consumed.
    const entries = readEntries(dir);
    const merged = entries.find((e) => frontmatterId(e) === MERGED_ID);
    expect(merged, "merged entry must be present in .md").toBeDefined();
    expect(MERGED_ID).toMatch(UUID_RE);
    expect(MERGED_ID).not.toBe(A_ID);
    expect(MERGED_ID).not.toBe(B_ID);
    // Consumed bodies are gone from the .md ground truth.
    expect(entries.some((e) => e.includes(BODY_A))).toBe(false);
    expect(entries.some((e) => e.includes(BODY_B))).toBe(false);

    // ── HONEST invariant (the gap): the store does NOT route consolidation-
    //    consumed md_ids through the md_id seam. The result carries NO
    //    evicted_md_ids and NO offloaded_superseded for the consumed set, so the
    //    adapter's DB-sync would sync an EMPTY set here. This documents the
    //    current production reality (cleanup is the child's content-key path).
    expect(result.evicted_md_ids ?? []).toEqual([]);
    expect(result.offloaded_superseded ?? []).toEqual([]);

    // Concretely: the consumed DB rows SURVIVE in the DB — the md_id seam did
    // NOT clean them, and this scenario does not drive the child content-key
    // path. In production they are cleaned only by the consolidator child's
    // removeSyncedMemories. When the tracked follow-up lands, flip these two to
    // .toBeNull() and require result.evicted_md_ids to carry [A_ID, B_ID].
    expect(await repo.getMdIdByContent(BODY_A, { target: "memory", project: null })).toBe(A_ID);
    expect(await repo.getMdIdByContent(BODY_B, { target: "memory", project: null })).toBe(B_ID);
  });

  // ── 2a. DEATH (D2 offload-superseded-first) ───────────────────────────
  test("offload (D2 superseded-first): superseded md_id hard-deleted from DB + .md together", async () => {
    const KEEP_ID = "11111111-1111-1111-1111-111111111111";
    const SUPER_ID = "22222222-2222-2222-2222-222222222222";
    const BODY_KEEP = "keep active dtwo probe";
    const BODY_SUPER = "superseded dtwo probe with padding text to ensure overflow happens here xxx";

    const { dir, store, backend, repo } = await setup({
      memoryCharLimit: 240,
      memoryOverflowStrategy: "auto-consolidate",
    });

    seedMemoryFile(dir, [fmEntry(KEEP_ID, BODY_KEEP), fmEntry(SUPER_ID, BODY_SUPER)]);
    await seedDbRow(repo, BODY_KEEP, KEEP_ID);
    await seedDbRow(repo, BODY_SUPER, SUPER_ID, { status: "superseded" });

    // Mirror index.ts's provider: the DB knows which md_ids are superseded.
    store.setSupersededContentProvider(async () => {
      const list = await repo.getMemories({ target: "memory", project: null, status: "superseded" });
      return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
    });
    // No consolidator wired: D2 purge alone must free enough space (sized so
    // [KEEP, new] fits once SUPER is purged) — the store returns at the
    // post-purge capacity check without ever reaching the consolidation branch.

    const result = await store.add("memory", "new note dtwo probe");
    expect(result.success).toBe(true);
    // The store returned the purged superseded md_id for the adapter to sync.
    expect(result.offloaded_superseded).toEqual([SUPER_ID]);

    // .md ground truth: superseded entry gone, keep + new remain.
    const entries = readEntries(dir);
    expect(entries.some((e) => frontmatterId(e) === SUPER_ID)).toBe(false);
    expect(entries.some((e) => frontmatterId(e) === KEEP_ID)).toBe(true);

    // ── DEATH: adapter hard-deletes the superseded DB row (traceless).
    await syncEvictions(backend, dir, result.offloaded_superseded!);
    expect(await repo.getMdIdByContent(BODY_SUPER, { target: "memory", project: null })).toBeNull();
    const allRows = await repo.getMemories({ target: "memory" });
    expect(allRows.some((r) => r.content === BODY_SUPER)).toBe(false);
    // The active keep-row survives untouched.
    expect(await repo.getMdIdByContent(BODY_KEEP, { target: "memory", project: null })).toBe(KEEP_ID);
  });

  // ── 2b. DEATH (vault-offload floor) + provenance ──────────────────────
  test("offload (vault-offload floor): DB row + md_id deleted together; vault archive carries retired md_id", async () => {
    const OLD_ID = "33333333-3333-3333-3333-333333333333";
    const KEEP_ID = "44444444-4444-4444-4444-444444444444";
    const BODY_OLD = "old vault floor probe one retireme aaa";
    const BODY_KEEP = "keep vault floor probe two stay xxx";

    const { dir, store, backend, repo } = await setup({
      memoryCharLimit: 260,
      memoryOverflowStrategy: "vault-offload",
    });

    seedMemoryFile(dir, [fmEntry(OLD_ID, BODY_OLD), fmEntry(KEEP_ID, BODY_KEEP)]);
    await seedDbRow(repo, BODY_OLD, OLD_ID);
    await seedDbRow(repo, BODY_KEEP, KEEP_ID);
    // No consolidator + no superseded provider → overflow falls straight to the
    // vault-offload floor (FIFO-evict oldest to a .knowledge.jsonl archive).

    const result = await store.add("memory", "new vault floor probe");
    expect(result.success).toBe(true);
    expect(result.evicted_md_ids).toEqual([OLD_ID]);
    expect(result.archive_path).toBeTruthy();

    // .md ground truth: oldest evicted, keep + new remain.
    const entries = readEntries(dir);
    expect(entries.some((e) => frontmatterId(e) === OLD_ID)).toBe(false);
    expect(entries.some((e) => frontmatterId(e) === KEEP_ID)).toBe(true);

    // ── Provenance: the vault archive carries the retired md_id.
    const archive = fs.readFileSync(result.archive_path!, "utf-8").trim().split("\n");
    const archived = archive.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(archived.some((r) => r.md_id === OLD_ID)).toBe(true);

    // ── DEATH: adapter hard-deletes the evicted DB row (traceless).
    await syncEvictions(backend, dir, result.evicted_md_ids!);
    expect(await repo.getMdIdByContent(BODY_OLD, { target: "memory", project: null })).toBeNull();
    const allRows = await repo.getMemories({ target: "memory" });
    expect(allRows.some((r) => r.content === BODY_OLD)).toBe(false);
    expect(await repo.getMdIdByContent(BODY_KEEP, { target: "memory", project: null })).toBe(KEEP_ID);
  });

  // ── 3. IMMUTABLE (supersession) ───────────────────────────────────────
  test("supersession: status flip active→superseded leaves .md id + DB md_id UNCHANGED (byte-identical)", async () => {
    const PRIOR_ID = "cccccccc-4444-4444-4444-444444444444";
    const BODY_PRIOR = "prior fact supersede immutprobe";
    const REPLACEMENT = "corrected fact supersede immutprobe v2";

    const { dir, store, backend, repo } = await setup({ memoryCharLimit: 10000 });

    seedMemoryFile(dir, [fmEntry(PRIOR_ID, BODY_PRIOR)]);
    const priorDbId = await seedDbRow(repo, BODY_PRIOR, PRIOR_ID);

    // Capture the byte-exact .md entry + the DB md_id BEFORE supersession.
    const beforeEntries = readEntries(dir);
    const priorEntryBefore = beforeEntries.find((e) => frontmatterId(e) === PRIOR_ID)!;
    const priorRowBefore = (await repo.getMemories({ target: "memory" })).find((r) => r.id === priorDbId)!;
    expect(priorRowBefore.status).toBe("active");
    expect(priorRowBefore.mdId).toBe(PRIOR_ID);

    // Supersede via the repo path, mirroring the memory_supersede tool's steps:
    //   1. store.add          — write the replacement to .md (new entry appended;
    //                           the prior .md entry is never touched).
    //   2. syncMemoryEntry    — mirror the replacement into the DB + capture id.
    //   3. supersedeMemory    — flip prior→superseded + stamp lineage.
    // The .md layer has NO lineage/status, so only the DB prior row changes.
    await store.add("memory", REPLACEMENT);
    const replacementSync = await repo.syncMemoryEntry({ content: REPLACEMENT, target: "memory", project: null });
    await repo.supersedeMemory(priorDbId, replacementSync.entry.id);

    // ── .md: the prior frontmatter entry is byte-identical pre/post.
    const afterEntries = readEntries(dir);
    const priorEntryAfter = afterEntries.find((e) => frontmatterId(e) === PRIOR_ID)!;
    expect(priorEntryAfter).toBe(priorEntryBefore);
    expect(frontmatterId(priorEntryAfter)).toBe(PRIOR_ID);

    // ── DB: prior row's md_id UNCHANGED, status flipped to superseded.
    const priorRowAfter = (await repo.getMemories({ target: "memory" })).find((r) => r.id === priorDbId)!;
    expect(priorRowAfter.mdId).toBe(PRIOR_ID); // byte-identical md_id
    expect(priorRowAfter.status).toBe("superseded"); // only the status flipped
    expect(priorRowAfter.supersededBy).toBe(replacementSync.entry.id);
  });

  // ── 4. IMMUTABLE (re-backfill) ────────────────────────────────────────
  test("id immutability: re-backfill never changes a present id (idempotent across runs)", async () => {
    const BODY_A = "alpha backfillprobe note";
    const BODY_B = "bravo backfillprobe note";

    const { dir, store, backend, repo } = await setup({ memoryCharLimit: 10000 });

    seedMemoryFile(dir, [commentEntry(BODY_A), commentEntry(BODY_B)]);
    await repo.addMemory({ content: BODY_A, target: "memory", project: null, created: TODAY, lastReferenced: TODAY });
    await repo.addMemory({ content: BODY_B, target: "memory", project: null, created: TODAY, lastReferenced: TODAY });

    // Wire the REAL repo as the backfill provider (mirrors index.ts global
    // store wiring: project always null from the store).
    store.setStableIdBackfillProvider({
      getMdIdByContent: (target, content) => repo.getMdIdByContent(content, { target, project: null }),
      setMdIdByContent: (target, content, mdId) => repo.setMdIdByContent(content, mdId, { target, project: null }),
    });

    // Run 1: legacy comment entries are upgraded to frontmatter + minted uuids.
    await store.loadFromDisk();
    const r1 = await store.backfillStableIds();
    expect(r1.upgraded).toBe(2);
    expect(r1.mdIdsMirrored).toBe(2);

    const idsAfterRun1 = readEntries(dir).map(frontmatterId);
    expect(idsAfterRun1.every((id) => id && UUID_RE.test(id))).toBe(true);
    expect(new Set(idsAfterRun1).size).toBe(2); // distinct uuids

    // Run 2: reload from disk (simulate a restart) → every entry is already
    // frontmatter, so the run is a strict no-op — ids must NOT be reassigned.
    await store.loadFromDisk();
    const r2 = await store.backfillStableIds();
    expect(r2.upgraded).toBe(0);
    expect(r2.mdIdsMirrored).toBe(0);

    const idsAfterRun2 = readEntries(dir).map(frontmatterId);
    expect(idsAfterRun2).toEqual(idsAfterRun1); // byte-identical id set

    // The DB mirror is stable too: each content's md_id is unchanged.
    expect(await repo.getMdIdByContent(BODY_A, { target: "memory", project: null })).toBe(idsAfterRun1[0]);
    expect(await repo.getMdIdByContent(BODY_B, { target: "memory", project: null })).toBe(idsAfterRun1[1]);
  });
});
