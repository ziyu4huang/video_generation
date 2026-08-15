/**
 * Task 7 — Write-path migration acceptance (integration). F1 fix gate.
 *
 * The 6 prior tasks migrated the READ / backfill / retire paths to `md_id`, but
 * never the WRITE/BIRTH path: `encodeEntry` still emitted a comment-shape line
 * (no frontmatter id) and the DB INSERTs omitted `md_id`. So entries born via
 * `store.add`/`replace` lacked an id until the next restart's backfill — and an
 * in-session entry that was evicted/transferred/superseded before that restart
 * had NO md_id, so `evicted_md_ids` was empty → the eviction mirror fired zero times
 * → a PERMANENT DB orphan (the pre-5d content-key delete had caught these).
 *
 * These three scenarios are the acceptance proof for the F1 fix. They BIRTH via
 * the REAL `store.add` (NOT direct frontmatter seeding) and drive the REAL
 * adapter mirror (`store.add` → `syncEvictions` → `syncMemoryEntry` with the
 * minted `added_md_id`), so the live-in-session bridge is exercised end-to-end:
 *
 *   • BIRTH        — a `store.add` birth writes a frontmatter `.md` entry WITH
 *                    an `id`, AND the DB row's `md_id` is the SAME uuid.
 *   • NO-ORPHAN    — an in-session birth that is FIFO-evicted carries its id in
 *                    `evicted_md_ids`; the adapter's deleteCard fires; the
 *                    DB row is gone (the F1 regression — must now pass).
 *   • D2 SUPERSEDE — a freshly-added (in-session) superseded entry IS purged
 *                    on overflow (the provider returns its md_id; purge matches).
 *
 * Harness mirrors `tests/integration/id-lifecycle.test.ts` (tmp memoryDir +
 * MemoryStore, SqliteBackend + SqliteMemoryRepository, backfill/superseded
 * provider wiring). The `addWithSync` helper is a verbatim mirror of the
 * production `memory-tool.ts` add-handler (kp13 Wave C: card-store mirror,
 * `added_md_id`-keyed).
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { createCardStore } from "../../src/store/card-store.js";
import { mirrorMemoryAdd, mirrorMemoryEvictions } from "../../src/store/memory-card-mirror.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import type { MemoryTarget, MemoryRepository } from "../../src/store/repository.js";

const TODAY = "2026-08-01";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── tmp-dir + backend lifecycle ─────────────────────────────────────────
const DIRS: string[] = [];
const BACKENDS: SqliteBackend[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-birthmdid-"));
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

// ─── helpers ─────────────────────────────────────────────────────────────

/** Extract the frontmatter `id` from an entry, or null when comment-shape. */
function frontmatterId(entry: string): string | null {
  if (!entry.startsWith("---\n")) return null;
  const m = entry.match(/^id: (.+)$/m);
  return m ? m[1]! : null;
}

/** Read a target's entries straight from the on-disk ground-truth file. */
function readEntries(dir: string): string[] {
  const raw = fs.readFileSync(path.join(dir, MEMORY_FILE), "utf-8");
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
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

/**
 * Verbatim mirror of the production `memory-tool.ts` add-handler (kp13 Wave C):
 * birth via `store.add`, mirror evictions (evicted_md_ids +
 * offloaded_superseded) via `mirrorMemoryEvictions` (deleteCard by md_id —
 * ids are globally unique, no target/project scope), then `mirrorMemoryAdd`
 * the new row with the minted `added_md_id` so the card row's id == the `.md`
 * frontmatter id. The card store is joined on the harness backend (bundle-join
 * style — same `memories` table the repo reads). Returns the raw store result
 * so callers can assert on evicted_md_ids / added_md_id.
 */
async function addWithSync(
  store: MemoryStore,
  backend: SqliteBackend,
  dir: string,
  target: MemoryTarget,
  content: string,
): Promise<ReturnType<MemoryStore["add"]>> {
  const cardStore = await createCardStore({ memoryDir: dir, sqliteBackend: backend });
  const result = await store.add(target, content);
  if (!result.success) return result;
  await mirrorMemoryEvictions(cardStore, result.evicted_md_ids ?? []);
  await mirrorMemoryEvictions(cardStore, result.offloaded_superseded ?? []);
  await mirrorMemoryAdd(cardStore, target === "user" ? "user" : target === "failure" ? "failure" : "memory", {
    mdId: result.added_md_id,
    content,
  });
  return result;
}

// ─── The 3 acceptance scenarios ──────────────────────────────────────────

describe("write-path birth md_id (ticket 7 / F1 fix)", () => {
  // ── 1. BIRTH: frontmatter id on .md AND md_id on the DB row, SAME uuid ──
  test("BIRTH: store.add writes a frontmatter .md entry WITH an id, and the DB row's md_id is the SAME uuid", async () => {
    const BODY = "birth probe single entry md-id parity check";

    const { dir, store, backend, repo } = await setup();

    const result = await addWithSync(store, backend, dir, "memory", BODY);
    expect(result.success).toBe(true);
    // The store surfaced the minted id (option (i) threading).
    expect(result.added_md_id).toMatch(UUID_RE);

    // .md ground truth: the entry is frontmatter carrying that id.
    const entries = readEntries(dir);
    const born = entries.find((e) => e.includes(BODY));
    expect(born, "born entry must be present in .md").toBeDefined();
    expect(born!.startsWith("---\n"), "born entry must be frontmatter").toBe(true);
    expect(frontmatterId(born!)).toBe(result.added_md_id);

    // DB row's md_id is the SAME uuid (the live-in-session bridge).
    expect(await repo.getMdIdByContent(BODY, { target: "memory", project: null })).toBe(result.added_md_id);
  });

  // ── 2. NO-ORPHAN on eviction: an in-session birth that is FIFO-evicted ─
  //    carries its id in evicted_md_ids; removeByMdId fires; DB row gone.
  test("NO-ORPHAN: an in-session birth evicted via the vault-offload floor carries its md_id and the DB row is deleted", async () => {
    const BODY_A = "first entry birth orphan probe alpha"; // evicted (oldest)
    const BODY_B = "second entry birth orphan probe beta with enough body to overflow"; // survives

    // Sized so [A,B] overflows; B alone fits (vault-offload floor requirement).
    const { dir, store, backend, repo } = await setup({
      memoryCharLimit: 175,
      memoryOverflowStrategy: "vault-offload",
    });

    // Birth A (in-session) → id on both sides.
    const resA = await addWithSync(store, backend, dir, "memory", BODY_A);
    expect(resA.success).toBe(true);
    const idA = resA.added_md_id!;
    expect(idA).toMatch(UUID_RE);
    expect(await repo.getMdIdByContent(BODY_A, { target: "memory", project: null })).toBe(idA);

    // Birth B → overflows → FIFO-evicts A (oldest) to the vault floor.
    const resB = await addWithSync(store, backend, dir, "memory", BODY_B);
    expect(resB.success).toBe(true);
    // REGRESSION ASSERTION (the F1 gap): the evicted in-session entry's md_id
    // IS surfaced. Pre-fix this was [] (A was comment-shape, id===undefined,
    // filtered out) → removeByMdId never fired → permanent DB orphan.
    expect(resB.evicted_md_ids).toEqual([idA]);

    // .md ground truth: A gone, B present.
    const entries = readEntries(dir);
    expect(entries.some((e) => frontmatterId(e) === idA)).toBe(false);
    expect(entries.some((e) => e.includes(BODY_B))).toBe(true);

    // DB: A's row is gone (adapter deleteCard fired inside addWithSync).
    expect(await repo.getMdIdByContent(BODY_A, { target: "memory", project: null })).toBeNull();
    const allRows = await repo.getMemories({ target: "memory" });
    expect(allRows.some((r) => r.content === BODY_A)).toBe(false);
    expect(allRows.some((r) => r.content === BODY_B)).toBe(true);
  });

  // ── 3. D2 supersede-fresh: a freshly-added superseded entry IS purged ──
  test("D2 SUPERSEDE: a freshly-added (in-session) superseded entry IS purged on overflow via its md_id", async () => {
    const BODY_KEEP = "keep d2f short"; // survives (active)
    const BODY_SUPER = "superseded d2f probe pad text to force overflow trigger xxx"; // flipped to superseded, then purged
    const BODY_NEW = "new note d2f overflow trigger"; // the add that overflows

    // Sized so [KEEP, SUPER] fit; [KEEP, SUPER, NEW] overflows; after purging
    // SUPER, [KEEP, NEW] fits (so the post-D2-purge capacity check passes and
    // the store returns at the purge branch instead of the consolidation floor).
    const { store, backend, dir, repo } = await setup({
      memoryCharLimit: 260,
      memoryOverflowStrategy: "auto-consolidate",
    });

    // Birth KEEP + SUPER in-session (the regression path: ids exist only via
    // this task's fix). No consolidator wired → D2 purge alone must free space.
    const resKeep = await addWithSync(store, backend, dir, "memory", BODY_KEEP);
    const resSuper = await addWithSync(store, backend, dir, "memory", BODY_SUPER);
    expect(resKeep.success && resSuper.success).toBe(true);
    const idSuper = resSuper.added_md_id!;
    expect(idSuper).toMatch(UUID_RE);
    expect(await repo.getMdIdByContent(BODY_SUPER, { target: "memory", project: null })).toBe(idSuper);

    // Flip BODY_SUPER to superseded in the DB via the real repo path (mirrors a
    // prior memory_supersede), so the provider returns its md_id.
    const superRow = (await repo.getMemories({ target: "memory" })).find((r) => r.content === BODY_SUPER)!;
    const replacement = await repo.addMemory({
      content: BODY_SUPER + " §REPL§",
      target: "memory",
      project: null,
      created: TODAY,
      lastReferenced: TODAY,
    });
    await repo.supersedeMemory(superRow.id, replacement.id);

    // Provider mirrors index.ts: returns superseded md_ids from the DB. Pre-fix
    // the freshly-added SUPER row had md_id NULL → filter(Boolean) dropped it →
    // D2 purged nothing. Post-fix SUPER carries idSuper → D2 purges it.
    store.setSupersededContentProvider(async () => {
      const list = await repo.getMemories({ target: "memory", project: null, status: "superseded" });
      return list.map((m) => m.mdId).filter((id): id is string => Boolean(id));
    });

    // The overflowing add → D2 offload-superseded-first purges SUPER from `.md`.
    const result = await addWithSync(store, backend, dir, "memory", BODY_NEW);
    expect(result.success).toBe(true);
    expect(result.offloaded_superseded).toContain(idSuper);

    // Adapter synced the purge (inside addWithSync) → SUPER's DB row is gone.
    expect(await repo.getMdIdByContent(BODY_SUPER, { target: "memory", project: null })).toBeNull();
    // KEEP survived untouched.
    const keepId = resKeep.added_md_id!;
    expect(await repo.getMdIdByContent(BODY_KEEP, { target: "memory", project: null })).toBe(keepId);
  });

  // ── 4. REPLACE: the new entry gets a FRESH uuid on BOTH sides ──────────
  test("REPLACE: store.replace births the new entry with a fresh uuid on .md AND the DB row's md_id", async () => {
    const BODY_OLD = "replace probe old content original";
    const BODY_NEW = "replace probe new content replacement fresh";

    const { dir, store, backend, repo } = await setup();

    // Birth the original entry.
    const resOld = await addWithSync(store, backend, dir, "memory", BODY_OLD);
    expect(resOld.success).toBe(true);
    const idOld = resOld.added_md_id!;
    expect(idOld).toMatch(UUID_RE);

    // Mirror the production replace-handler: store.replace, then
    // replaceSyncedMemories threading the new md_id onto the updated row.
    const repResult = await store.replace("memory", BODY_OLD, BODY_NEW);
    expect(repResult.success).toBe(true);
    expect(repResult.added_md_id).toMatch(UUID_RE);
    const idNew = repResult.added_md_id!;
    expect(idNew).not.toBe(idOld); // fresh uuid, the old entry's id is not reused

    await repo.replaceSyncedMemories(BODY_OLD, {
      content: BODY_NEW,
      target: "memory",
      project: null,
      mdId: idNew,
    });

    // .md: the replacement entry carries the fresh id.
    const entries = readEntries(dir);
    const replaced = entries.find((e) => e.includes(BODY_NEW));
    expect(replaced, "replacement entry must be present in .md").toBeDefined();
    expect(frontmatterId(replaced!)).toBe(idNew);

    // DB: the updated row's md_id is the SAME fresh uuid (parity on both sides).
    expect(await repo.getMdIdByContent(BODY_NEW, { target: "memory", project: null })).toBe(idNew);
    // The old content is gone (replace is an in-place content update).
    expect(await repo.getMdIdByContent(BODY_OLD, { target: "memory", project: null })).toBeNull();
  });
});
