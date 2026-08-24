/**
 * Unit tests for MemoryStore — core persistent memory with file-backed storage.
 *
 * Determinism: writes go to a per-test tmpdir (mkdtemp under os.tmpdir()),
 * never the real ~/.pi/agent/memory/. The tmpdir is passed as `memoryDir` so
 * MemoryStore resolves every file (MEMORY.md / USER.md / failures.md) inside
 * it; before/afterEach clean the slate and the whole dir is removed in after.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";


import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "../../src/constants.js";
import { serializeMetadataFrontmatter } from "../../src/store/memory-format.js";
import { computeSignature } from "../../src/store/signature.js";
import type { FailureState, MemoryConfig } from "../../src/types.js";
import * as lockfile from "proper-lockfile";

// ─── Helpers (module-level) ───

const TEST_MARKER = "[MEMORY-TEST]";
let MEMORY_DIR = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

/** Read raw file content, return "" if missing. */
async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Write a file (creating directories if needed). */
async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/** Delete a file, ignoring errors. */
async function removeFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}

// ─── 2-phase consolidation race helpers (Task 5 update-safety gate) ───
//
// These bypass the store entirely and touch the `.md` file with fs, simulating
// a concurrent sibling session mutating the file while step 2 of the 2-phase
// consolidation runs lock-FREE. Step 3 (brief locked reconcile) must re-read
// disk and preserve those concurrent edits — that is the invariant under test.

/** Encode an entry exactly as the store does (mirror of serializeMetadataComment).
 *  Used for raw disk injection, not for the store's own writes. */
function encodeRaw(content: string, created = "2026-08-01", last = "2026-08-01"): string {
  return `${content} <!-- created=${created}, last=${last} -->`;
}

/** Append an encoded entry directly to a target .md file, BYPASSING the store.
 *  Prepends ENTRY_DELIMITER so it parses as a separate entry. Simulates a
 *  concurrent session appending while step 2 runs. */
async function appendEntryToDisk(filePath: string, encoded: string): Promise<void> {
  await fs.appendFile(filePath, `${ENTRY_DELIMITER}${encoded}`, "utf-8");
}

/** Rewrite a .md file without its first entry (simulate a concurrent remove). */
async function removeFirstEntryFromDisk(filePath: string): Promise<void> {
  const raw = await readRaw(filePath);
  const parts = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
  parts.shift();
  await writeRaw(filePath, parts.join(ENTRY_DELIMITER));
}

/** Total chars the store would measure for a .md file (entries joined by
 *  ENTRY_DELIMITER), reading straight from disk. Mirrors MemoryStore.charCount. */
async function totalCharsOnDisk(filePath: string): Promise<number> {
  const raw = await readRaw(filePath);
  const parts = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
  return parts.length ? parts.join(ENTRY_DELIMITER).length : 0;
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

function failureEntry(text: string, createdDaysAgo = 0): string {
  const date = dateDaysAgo(createdDaysAgo);
  return `${text} <!-- created=${date}, last=${date} -->`;
}

/** Build a frontmatter-shape failure entry (ticket 05 stable-id format) carrying
 *  an optional failure-lifecycle `state`. Used by the failure-lifecycle tests to
 *  seed resolved/acquired/active entries directly on disk so the injection
 *  filter can be exercised. */
function frontmatterFailureEntry(text: string, opts: { state?: FailureState; createdDaysAgo?: number } = {}): string {
  const date = dateDaysAgo(opts.createdDaysAgo ?? 0);
  return serializeMetadataFrontmatter({
    id: globalThis.crypto.randomUUID(),
    text,
    created: date,
    last: date,
    ...(opts.state ? { state: opts.state } : {}),
  });
}

// ─── Tests ───

describe("MemoryStore", { concurrency: 1 }, () => {
  let memoryPath = "";
  let userPath = "";
  let failurePath = "";

  beforeAll(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
    userPath = path.join(MEMORY_DIR, USER_FILE);
    failurePath = path.join(MEMORY_DIR, "failures.md");
  });

  afterAll(async () => {
    // Clean up temp directory
    try {
      await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /** Remove both memory files. No sleep is needed: every test awaits its
   *  mutations (add / replace / remove all await saveToDisk via runExclusive),
   *  so by the time this runs in before/afterEach no write is in flight. The
   *  old arbitrary setTimeout polls here were stale insurance from a prior
   *  fire-and-forget write design that no longer exists — they cost ~600ms per
   *  test (~24s across the suite) for nothing. */
  async function cleanSlate(): Promise<void> {
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    // Defensive: also clear residual proper-lockfile lock dirs (`<path>.lock`)
    // a crashed/interrupted test may have left. cleanSlate only removed the
    // .md; a stale lock would ELOCKED the next test's cross-process acquisition
    // and cascade (the add errors out before the lock-hold wrap fires). Best-effort.
    for (const p of [memoryPath, userPath, failurePath]) {
      try { await fs.rm(`${p}.lock`, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  beforeEach(async () => {
    await cleanSlate();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  // ─── add() tests ───

  describe("add()", () => {
    it("persists entry to file and returns success with usage stats", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} project uses pnpm`);

      assert.ok(result.success);
      assert.equal(result.target, "memory");
      assert.ok(result.usage);
      assert.ok(result.usage!.includes("chars"));
      assert.equal(result.entry_count, 1);
      assert.equal(result.message, "Entry added.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} project uses pnpm`));
    });

    it("no-ops on duplicate entry and returns message", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} dup test entry`;
      const r1 = await store.add("memory", entry);
      assert.ok(r1.success);
      assert.equal(r1.entry_count, 1);

      const r2 = await store.add("memory", entry);

      assert.ok(r2.success);
      assert.equal(r2.entry_count, 1);
      assert.equal(r2.message, "Entry already exists (no duplicate added).");

      const raw = await readRaw(memoryPath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("returns error when content would exceed char limit", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 50 }));
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
      assert.ok(result.error!.includes("chars"));
    });

    it("rejects without consolidation when memoryOverflowStrategy is reject", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "reject",
        autoConsolidate: true,
      }));
      store.setConsolidator(async (snapshot) => {
        consolidatorCalled = true;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.equal(consolidatorCalled, false);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    // D3 behavioral change (Task 2): under the OLD code, fifo-evict dispatch
    // directly to fifoEvictAndAdd, which shift()'d the oldest ACTIVE entry
    // without ever calling the consolidator. Post-D3, fifo-evict collapses onto
    // the consolidation path: the consolidator IS invoked, and because this stub
    // returns consolidated:true without freeing space, the retried add falls to
    // the vault-offload floor (evicting the oldest to the archive). The end
    // result is the same (oldest entry `first` is removed), but the mechanism —
    // and the message/archive_path — differ. See task-2-report.md.
    it("fifo-evict consolidates before evicting (D3: never shift()s active directly)", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 250,
        memoryOverflowStrategy: "fifo-evict",
        autoConsolidate: true,
      }));
      store.setConsolidator(async (snapshot) => {
        consolidatorCalled = true;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();

      const first = `${TEST_MARKER} fifo first`;
      const second = `${TEST_MARKER} fifo second`;
      const next = `${TEST_MARKER} fifo next`;

      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      // D3: consolidator IS now invoked (was false under the old fifo-shift dispatch).
      assert.equal(consolidatorCalled, true);
      // The stub frees nothing, so the retried add hits the vault-offload floor.
      assert.equal(result.message, "Memory updated. Offloaded 1 older entry to vault archive to stay within the limit.");
      assert.deepEqual(result.evicted_entries, [first]);
      assert.equal(result.evicted_count, 1);
      assert.equal(result.entry_count, 2);
      assert.ok(result.archive_path, "floor should write a vault archive");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first));
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
      assert.ok(raw.indexOf(second) < raw.indexOf(next));
    });

    it("does not evict when the new entry cannot fit an empty memory", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 150,
        memoryOverflowStrategy: "fifo-evict",
      }));
      await store.loadFromDisk();

      const existing = `${TEST_MARKER} keep me`;
      assert.ok((await store.add("memory", existing)).success);

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(120)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(existing));
    });

    it("auto-consolidate floor: when consolidation frees nothing, vault-offloads oldest instead of hard-rejecting", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 260,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      store.setConsolidator(async (snapshot) => ({ plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }));
      await store.loadFromDisk();

      const first = `${TEST_MARKER} floor first oldest`;
      const second = `${TEST_MARKER} floor second`;
      const next = `${TEST_MARKER} floor next incoming`;
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      assert.deepEqual(result.evicted_entries, [first]);
      assert.ok(result.archive_path, "floor should write a vault archive");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first), "oldest evicted to archive");
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
    });

    it("auto-consolidate floor: fires with no consolidator wired (never hard-rejects)", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 260,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      // no setConsolidator — consolidator unavailable
      await store.loadFromDisk();

      const first = `${TEST_MARKER} nocons first`;
      const second = `${TEST_MARKER} nocons second`;
      const next = `${TEST_MARKER} nocons next`;
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(next));
      assert.ok(raw.includes(second));
      assert.ok(!raw.includes(first));
    });

    it("auto-consolidate floor: a single entry larger than the whole budget still rejects", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      store.setConsolidator(async (snapshot) => ({ plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }));
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    // D2: superseded entries are offloaded (purged from .md) BEFORE any
    // destructive strategy runs. The provider is injected (test fakes it;
    // production wires repo.getMemories({status:"superseded"}) in Task 3).
    // NOTE: memoryCharLimit calibrated so 2 frontmatter seeds fit + a 3rd add
    // overflows, and after purging the superseded one the keeper + new entry
    // fit (the D2 happy path that surfaces offloaded_superseded). Frontmatter
    // entries (~90-char header + body) are larger than the legacy comment
    // shape, so the limit is raised from the original 180→220→250 (Task 7
    // births emit a ~86-char frontmatter header, so [KEEP, new] must stay
    // under the limit after the D2 purge to hit the early-return success).
    it("overflow offloads superseded entries first (injected provider) before any destructive strategy", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 250 }));

      // Seed two FRONTMATTER entries (post-backfill shape) directly on disk —
      // _addInner reloads from disk, so direct injection into the array would
      // be wiped. The DB reports the SECOND as superseded (by md_id now).
      const KEEP_ID = "aaaa0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
      const SUPER_ID = "bbbb1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b";
      const TODAY = new Date().toISOString().split("T")[0];
      const fm = (id: string, body: string) => `---\nid: ${id}\ncreated: ${TODAY}\nlast: ${TODAY}\n---\n${body}`;
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      await fs.writeFile(
        p.join(MEMORY_DIR, MEMORY_FILE),
        [fm(KEEP_ID, "keep me active overflowprobe aaa"), fm(SUPER_ID, "superseded one overflowprobe bbb")].join(ENTRY_DELIMITER),
        "utf-8",
      );
      // Provider returns the MD_ID of the entry that is superseded in the DB.
      store.setSupersededContentProvider(async () => [SUPER_ID]);

      // This add overflows; expect the superseded entry purged and the new one added.
      const result = await store.add("memory", "new entry overflowprobe ccc");

      assert.ok(result.success, result.error);
      // offloaded_superseded is md_id-only now (no archive/display consumer).
      assert.deepEqual(result.offloaded_superseded, [SUPER_ID]);

      // The superseded entry must no longer be in the .md entries.
      const entries = store.getMemoryEntries();
      assert.ok(!entries.some((e) => e.includes("superseded one overflowprobe bbb")));
      // The active entry and the new entry remain.
      assert.ok(entries.some((e) => e.includes("keep me active overflowprobe aaa")));
      assert.ok(entries.some((e) => e.includes("new entry overflowprobe ccc")));
    });

    // Pin field (ticket 02): a pinned entry is NEVER eligible for overflow-
    // driven eviction. Purge of superseded entries must SKIP a pinned entry even
    // when its md_id is in the superseded set (pin protects *deletion*; the row
    // still flips status='superseded' in the DB for search). Calibrated so 3
    // frontmatter seeds overflow, and after purging the non-pinned superseded
    // entry the pinned one + the new entry fit (the D2 early-return success).
    it("pin: a pinned superseded entry survives purgeSupersededFromMarkdown while a non-pinned superseded peer is purged", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 250 }));

      const PIN_ID = "cccc0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c";
      const SUPER_ID = "dddd1d1d-1d1d-1d1d-1d1d-1d1d1d1d1d1d";
      const TODAY = new Date().toISOString().split("T")[0];
      const fm = (id: string, body: string, pin = false) =>
        serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY, ...(pin ? { pin: true } : {}) });
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      await fs.writeFile(
        p.join(MEMORY_DIR, MEMORY_FILE),
        [
          fm(PIN_ID, "pinned survivor supersededprobe aaa", true),
          fm(SUPER_ID, "plain superseded supersededprobe bbb"),
        ].join(ENTRY_DELIMITER),
        "utf-8",
      );
      // The DB reports BOTH as superseded. Pin must protect the pinned one.
      store.setSupersededContentProvider(async () => [PIN_ID, SUPER_ID]);

      const result = await store.add("memory", "new entry supersededprobe ccc");

      assert.ok(result.success, result.error);
      // Only the NON-pinned superseded entry is purged.
      assert.deepEqual(result.offloaded_superseded, [SUPER_ID]);

      const entries = store.getMemoryEntries();
      // The pinned superseded entry SURVIVES (pin protects deletion).
      assert.ok(entries.some((e) => e.includes("pinned survivor supersededprobe aaa")), "pinned superseded entry must survive purge");
      // The non-pinned superseded entry is gone.
      assert.ok(!entries.some((e) => e.includes("plain superseded supersededprobe bbb")), "non-pinned superseded entry must be purged");
      // The new entry lands.
      assert.ok(entries.some((e) => e.includes("new entry supersededprobe ccc")));
    });

    // Pin field (ticket 02): the vault-offload FIFO floor must SKIP pinned
    // entries — evict the oldest NON-pinned entries only. A pinned entry always
    // survives an overflow that evicts older (by file position) non-pinned
    // peers. Uses vault-offload strategy with NO consolidator so it falls
    // straight to the never-fail floor.
    it("pin: a pinned entry survives vaultOffloadAndAdd that evicts older non-pinned peers", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 250,
        memoryOverflowStrategy: "vault-offload",
      }));
      // No consolidator wired → overflow falls straight to vaultOffloadAndAdd.

      const PIN_ID = "eeee0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e";
      const PLAIN_ID = "ffff1f1f-1f1f-1f1f-1f1f-1f1f1f1f1f1f";
      const TODAY = new Date().toISOString().split("T")[0];
      const fm = (id: string, body: string, pin = false) =>
        serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY, ...(pin ? { pin: true } : {}) });
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      // OLDEST (first on disk) is the pinned one; the plain one is newer.
      await fs.writeFile(
        p.join(MEMORY_DIR, MEMORY_FILE),
        [
          fm(PIN_ID, "pinned oldest survivor vaultprobe aaa", true),
          fm(PLAIN_ID, "plain newer vaultprobe bbb"),
        ].join(ENTRY_DELIMITER),
        "utf-8",
      );

      const result = await store.add("memory", "new entry vaultprobe cc");

      assert.ok(result.success, result.error);
      // The FIFO loop would normally shift the OLDEST (the pinned one) first;
      // pin protection must evict the non-pinned peer instead.
      assert.equal(result.evicted_count, 1, "exactly one non-pinned entry evicted");
      assert.deepEqual(result.evicted_entries, ["plain newer vaultprobe bbb"],
        "must evict the non-pinned peer, NOT the pinned oldest");
      // evicted_md_ids mirrors the same single non-pinned id.
      assert.deepEqual(result.evicted_md_ids, [PLAIN_ID]);

      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("pinned oldest survivor vaultprobe aaa")), "pinned entry must survive vault-offload");
      assert.ok(!entries.some((e) => e.includes("plain newer vaultprobe bbb")), "non-pinned peer must be evicted");
      assert.ok(entries.some((e) => e.includes("new entry vaultprobe cc")));
    });

    // Pin field (ticket 02): the 2-phase LLM consolidation is the PRIMARY
    // overflow path in production (consolidator wired in src/index.ts). Pinned
    // entries must be EXCLUDED from the consolidation snapshot so the LLM can't
    // drop/merge them; applyMergePlan then keeps them (no plan op references
    // them). This stub tries to drop EVERY entry it is handed — the pinned one
    // survives purely because it never reaches the snapshot.
    it("pin: a pinned entry survives 2-phase consolidation that drops every snapshot entry", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 260,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      const PIN_ID = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
      const PLAIN_ID = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";
      const TODAY = new Date().toISOString().split("T")[0];
      const fm = (id: string, body: string, pin = false) =>
        serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY, ...(pin ? { pin: true } : {}) });
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      await fs.writeFile(
        p.join(MEMORY_DIR, MEMORY_FILE),
        [
          fm(PIN_ID, "pinned survivor consolidationprobe aaa", true),
          fm(PLAIN_ID, "plain droppable consolidationprobe bbb"),
        ].join(ENTRY_DELIMITER),
        "utf-8",
      );

      let snapshotSize = -1;
      store.setConsolidator(async (snapshot) => {
        // The consolidator tries to drop EVERY entry it is handed.
        snapshotSize = snapshot.entries.length;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })) } };
      });

      const result = await store.add("memory", "new entry consolidationprobe ccc");
      assert.ok(result.success, result.error);

      // The pinned entry was EXCLUDED from the snapshot: with 2 entries on disk,
      // the consolidator saw only 1 (the non-pinned one) — and still couldn't
      // drop the pinned entry because it was never a consolidation candidate.
      assert.equal(snapshotSize, 1, "pinned entry must be excluded from the consolidation snapshot");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("pinned survivor consolidationprobe aaa")), "pinned entry must survive consolidation");
      assert.ok(!entries.some((e) => e.includes("plain droppable consolidationprobe bbb")), "non-pinned entry must be dropped by the consolidator");
      assert.ok(entries.some((e) => e.includes("new entry consolidationprobe ccc")));
    });

    // D3: when no superseded entries remain, ALL non-reject strategies route to
    // consolidation — fifo-evict/vault-offload no longer shift() an active entry.
    it("all-active overflow routes to consolidation, not fifo/vault shift", async () => {
      // Use fifo-evict strategy to PROVE even fifo now consolidates instead of shift()ing active.
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 180, memoryOverflowStrategy: "fifo-evict" }));
      assert.ok((await store.add("memory", "active one activeonlyprobe aaa")).success);
      assert.ok((await store.add("memory", "active two activeonlyprobe bbb")).success);
      // No superseded to offload.
      store.setSupersededContentProvider(async () => []);
      let consolidateCalls = 0;
      store.setConsolidator(async (snapshot) => {
        consolidateCalls++;
        // Simulate consolidation freeing space: drop every seeded entry so the
        // retried (locked) write fits. A real summarizing merge would rewrite
        // the .md; this stub fakes that by returning a drop-all plan. Step 3
        // applies it (lock held briefly), then _add re-enters the locked write.
        return {
          plan: {
            snapshotBaseHash: snapshot.snapshotBaseHash,
            ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })),
          },
        };
      }, "stub");

      // Overflow with no superseded available → must consolidate, not fifo-shift active.
      const result = await store.add("memory", "overflow activeonlyprobe ccc");

      // D3: consolidator was invoked (under the old fifo-evict branch it would
      // have shift()'d an active entry without ever calling the consolidator).
      assert.ok(consolidateCalls > 0, `consolidator should have been called; got ${consolidateCalls}`);
      assert.ok(result.success, result.error);
    });

    // ── 2-phase consolidation: the LLM (step 2) runs with the cross-process
    //    file lock RELEASED. This is the defining invariant of the refactor —
    //    today consolidation runs IN-LOCK (up to ~60s), causing ELOCKED
    //    contention across sibling sessions. The injected consolidator now
    //    PRODUCES A PLAN (no writes); the store applies it in a brief locked
    //    reconcile (step 3). This test asserts the lock is FREE while the
    //    consolidator runs, and the store stays consistent afterward.
    it("2-phase consolidation: the file lock is FREE during the LLM (step 2) and the store stays consistent", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      // Assume the worst; the consolidator must prove the lock is free.
      let lockHeldDuringStep2 = true;
      // Plan that drops every seeded entry → consolidates to empty so the
      // retried (locked) write fits. drop-all mirrors a real summarizing merge.
      store.setConsolidator(async (snapshot) => {
        // _heldFileLocks tracks cross-process locks held by THIS process; it
        // must be empty during the lock-free plan step.
        lockHeldDuringStep2 = (store as unknown as { _heldFileLocks: Set<string> })._heldFileLocks.size > 0;
        return {
          plan: {
            snapshotBaseHash: snapshot.snapshotBaseHash,
            ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })),
          },
        };
      }, "lockfree-stub");
      await store.loadFromDisk();

      const first = `${TEST_MARKER} 2phase first seeded`;
      const second = `${TEST_MARKER} 2phase second seeded`;
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      // Third add overflows → 2-phase consolidation (step 2 lock-free) → the
      // retried locked write fits.
      const result = await store.add("memory", `${TEST_MARKER} 2phase third incoming`);

      assert.equal(lockHeldDuringStep2, false,
        "the cross-process file lock must NOT be held during the LLM plan (step 2)");
      assert.ok(result.success, `retried add should fit after consolidation; got: ${result.error}`);
      const entries = store.getMemoryEntries();
      assert.ok(!entries.some((e) => e.includes("2phase first seeded")), "dropped by the merge plan");
      assert.ok(!entries.some((e) => e.includes("2phase second seeded")), "dropped by the merge plan");
      assert.ok(entries.some((e) => e.includes("2phase third incoming")), "the retried add lands");
    });

    it("returns error for empty content", async () => {
      const store = new MemoryStore(makeConfig());

      const result = await await store.add("memory", "   ");
      assert.ok(!result.success);
      assert.equal(result.error, "Content cannot be empty.");
    });

    it("writes to USER.md for 'user' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("user", `${TEST_MARKER} prefers dark mode`);

      assert.ok(result.success);
      assert.equal(result.target, "user");

      const raw = await readRaw(userPath);
      assert.ok(raw.includes(`${TEST_MARKER} prefers dark mode`));

      const memRaw = await readRaw(memoryPath);
      assert.equal(memRaw, "");
    });

    it("writes to MEMORY.md for 'memory' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} uses node 22`);

      assert.ok(result.success);
      assert.equal(result.target, "memory");

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} uses node 22`));
    });

    it("handles content with § delimiter in entry", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} section divider${ENTRY_DELIMITER}continued`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles unicode content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} 日本語テスト 🧪`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles very long entry near char limit", async () => {
      const limit = 250;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      // Account for metadata overhead (~45 chars for <!-- created=..., last=... -->)
      const entry = `${TEST_MARKER} ${"a".repeat(limit - 100)}`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success, `Expected success but got error: ${result.error}`);
    });

    it("handles sequential adds (two in sequence)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const r1 = await store.add("memory", `${TEST_MARKER} first entry`);
      assert.ok(r1.success, `First add failed: ${r1.error}`);

      const r2 = await store.add("memory", `${TEST_MARKER} second entry`);
      assert.ok(r2.success, `Second add failed: ${r2.error}`);

      assert.equal(r2.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} first entry`));
      assert.ok(raw.includes(`${TEST_MARKER} second entry`));
    });
  });

  describe("addFailure()", () => {
    it("applies failure-target char limits (configurable via failureCharLimit)", async () => {
      const store = new MemoryStore(makeConfig({ failureCharLimit: 80 }));
      await store.loadFromDisk();

      const result = await store.addFailure(`${TEST_MARKER} ${"x".repeat(120)}`, {
        category: "failure",
      });

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("default failure limit is generous (40000) — a large write lands without overflow", async () => {
      // Regression: the old limit was memoryCharLimit*2 = 20000, so failures.md
      // (chronically ~20k from cross-session error capture) overflowed on nearly
      // every write -> triggered a 60s LLM consolidation under the file lock ->
      // cross-session ELOCKED. The higher default (40000) gives headroom so a
      // normal-large write lands without overflow.
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      // 25000 chars: over the OLD 20000 limit, under the NEW 40000 default.
      const result = await store.addFailure(`${TEST_MARKER} ${"x".repeat(25000)}`, {
        category: "failure",
      });

      assert.ok(result.success, `expected success under the 40000 default, got: ${result.error}`);
    });

    it("deduplicates exact failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });

      assert.ok(first.success);
      assert.equal(first.message, "Failure memory saved: correction");
      assert.ok(second.success);
      assert.equal(second.message, "Entry already exists (no duplicate added).");
      assert.equal(second.entry_count, 1);

      const raw = await readRaw(failurePath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });
  });

  // ─── replace() tests ───

  describe("replace()", () => {
    it("updates entry in file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} uses vim`);

      const result = await store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);

      assert.ok(result.success);
      assert.equal(result.message, "Entry replaced.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} uses vim`));
      assert.ok(raw.includes(`${TEST_MARKER} uses neovim`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "nonexistent substring", "new content");

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for multiple matches", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} config: port=8080`);
      await store.add("memory", `${TEST_MARKER} config: port=9090`);

      const result = await store.replace("memory", "config:", `${TEST_MARKER} unified config`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("Multiple entries matched"));
      assert.ok(result.matches);
      assert.equal(result.matches!.length, 2);
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "  ", "new content");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("returns error for empty new_content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", `${TEST_MARKER} some entry`, "   ");

      assert.ok(!result.success);
      assert.equal(result.error, "new_content cannot be empty. Use 'remove' to delete entries.");
    });

    it("replace() overflow with non-reject strategy vault-offloads oldest OTHER entries (never hard-rejects)", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 380,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();

      const oldest = `${TEST_MARKER} repl oldest evicted`;
      const mid = `${TEST_MARKER} repl mid keep`;
      const target = `${TEST_MARKER} repl target orig`;
      assert.ok((await store.add("memory", oldest)).success);
      assert.ok((await store.add("memory", mid)).success);
      assert.ok((await store.add("memory", target)).success);

      // Grow `target` so the replacement overflows; the floor must evict the
      // OLDEST OTHER entry (oldest), never the replaced one (target).
      const grown = `${TEST_MARKER} repl target grown ${"z".repeat(70)}`;
      const result = await store.replace("memory", target, grown);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      assert.deepEqual(result.evicted_entries, [oldest], "evict oldest OTHER, not the replaced entry");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(oldest), "oldest other evicted");
      assert.ok(raw.includes(grown), "replacement landed");
      assert.ok(raw.includes(mid), "unrelated entry kept");
      assert.ok(!raw.includes("repl target orig"), "old target text replaced away");
    });

    it("replace() overflow with reject strategy preserves the hard error", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 250,
        memoryOverflowStrategy: "reject",
        autoConsolidate: false,
      }));
      await store.loadFromDisk();

      const keep = `${TEST_MARKER} rj keep`;
      const target = `${TEST_MARKER} rj target`;
      assert.ok((await store.add("memory", keep)).success);
      assert.ok((await store.add("memory", target)).success);

      const result = await store.replace("memory", target, `${TEST_MARKER} ${"y".repeat(200)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("would put memory at"));
    });

    it("replace() a single replacement larger than the whole budget still rejects", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 130,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();
      assert.ok((await store.add("memory", `${TEST_MARKER} tiny`)).success);

      const result = await store.replace("memory", "tiny", `${TEST_MARKER} ${"w".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
    });
  });

  // ─── Heat-ordered eviction floors (UPSP §1, ticket #1b) ───
  //
  // The two deterministic overflow floors (vaultOffloadAndAdd via add() +
  // vaultOffloadAndReplace via replace()) evict the LOWEST-heat non-pinned
  // victim first when a heat provider is wired; they fall back to EXACT
  // FIFO/file-order when the provider is absent / empty / throwing (the
  // first-class disable-path invariant). Pin is always spared. These tests
  // stub the provider with a fixed heat Map so victim-selection is exercised
  // deterministically — the heat *scoring* math is Task 1's pure core
  // (tests/store/heat.test.ts); here we only assert consumption ORDER.
  describe("heat-ordered eviction floors (UPSP §1)", () => {
    const TODAY = new Date().toISOString().split("T")[0];
    const fm = (id: string, body: string, pin = false) =>
      serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY, ...(pin ? { pin: true } : {}) });

    /** Seed frontmatter entries (in the given disk/file order) into MEMORY.md. */
    async function seed(entries: string[]): Promise<void> {
      await fs.writeFile(path.join(MEMORY_DIR, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
    }

    // ── vaultOffloadAndAdd (the add() overflow floor) ──

    it("add floor: evicts the LOWEST-heat non-pinned entry first (heat-ascending)", async () => {
      const HOT_ID = "11111111-1111-4111-8111-111111111111";
      const WARM_ID = "22222222-2222-4222-8222-222222222222";
      const COLD_ID = "33333333-3333-4333-8333-333333333333";
      const HOT = fm(HOT_ID, "HOT survivor heatorderedprobe aaa keep this entry high heat");
      const WARM = fm(WARM_ID, "WARM middle heatorderedprobe bbb medium heat value stays");
      const COLD = fm(COLD_ID, "COLD evictee heatorderedprobe ccc low heat drop me now plz");
      // limit chosen so the 3 seeded entries fit, but adding a 4th forces
      // EXACTLY one eviction (the coldest). Tuned to frontmatter overhead.
      await seed([HOT, WARM, COLD]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 460, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === HOT_ID) m.set(HOT_ID, 0.9);
          if (e.mdId === WARM_ID) m.set(WARM_ID, 0.5);
          if (e.mdId === COLD_ID) m.set(COLD_ID, 0.1);
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming heatorderedprobe ddd trigger overflow xxxxxx");
      assert.ok(result.success, result.error);

      assert.equal(result.evicted_count, 1, "exactly the single coldest entry is evicted");
      assert.deepEqual(result.evicted_md_ids, [COLD_ID], "coldest md_id evicted first");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("HOT survivor")), "hottest entry survives");
      assert.ok(!entries.some((e) => e.includes("COLD evictee")), "coldest entry evicted");
    });

    it("add floor: multi-eviction order is heat-ASCENDING (coldest → warmest; hottest survives)", async () => {
      const HOT_ID = "11111111-1111-4111-8111-111111111111";
      const WARM_ID = "22222222-2222-4222-8222-222222222222";
      const COLD_ID = "33333333-3333-4333-8333-333333333333";
      const HOT = fm(HOT_ID, "HOT survivor heatascprobe aaa keep this entry high heat");
      const WARM = fm(WARM_ID, "WARM middle heatascprobe bbb medium heat value stays");
      const COLD = fm(COLD_ID, "COLD evictee heatascprobe ccc low heat drop me now plz");
      // Tighter limit forces TWO evictions (coldest + warmest), hottest survives.
      await seed([HOT, WARM, COLD]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 340, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === HOT_ID) m.set(HOT_ID, 0.9);
          if (e.mdId === WARM_ID) m.set(WARM_ID, 0.5);
          if (e.mdId === COLD_ID) m.set(COLD_ID, 0.1);
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming heatascprobe ddd trigger overflow xxxxxx");
      assert.ok(result.success, result.error);

      assert.equal(result.evicted_count, 2, "two coldest entries evicted");
      assert.deepEqual(result.evicted_md_ids, [COLD_ID, WARM_ID], "eviction order is heat-ascending");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("HOT survivor")), "hottest entry survives");
      assert.ok(!entries.some((e) => e.includes("COLD evictee")) && !entries.some((e) => e.includes("WARM middle")), "two coldest evicted");
    });

    it("add floor: at equal recency a USED entry outranks an UNUSED one (the usedBonus is consumed as heat)", async () => {
      // Same created/last → equal recency spine. The provider (mirroring
      // computeHeat's usedBonus, Task 1) scores the used entry +0.1 higher →
      // it is spared; the unused one is evicted. This asserts the store
      // CONSUMES that bonus (lowest-heat-first), not the bonus math itself.
      const USED_ID = "44444444-4444-4444-8444-444444444444";
      const UNUSED_ID = "55555555-5555-4555-8555-555555555555";
      const USED = fm(USED_ID, "USED survivor usedprobe aaa this entry was content-matched");
      const UNUSED = fm(UNUSED_ID, "UNUSED evictee usedprobe bbb never surfaced-used drop me");
      await seed([USED, UNUSED]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 300, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === USED_ID) m.set(USED_ID, 0.6); // recency 0.5 + usedBonus 0.1
          if (e.mdId === UNUSED_ID) m.set(UNUSED_ID, 0.5); // recency 0.5, no bonus
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming usedprobe ccc trigger overflow xxxxxxxxxx");
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [UNUSED_ID], "unused entry evicted; used entry spared");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("USED survivor")), "used entry survives");
      assert.ok(!entries.some((e) => e.includes("UNUSED evictee")), "unused entry evicted");
    });

    it("add floor: a PINNED entry at the lowest heat is spared; a higher-heat non-pinned is evicted instead", async () => {
      const PIN_ID = "66666666-6666-4666-8666-666666666666";
      const PLAIN_ID = "77777777-7777-4777-8777-777777777777";
      // Pinned entry carries the LOWEST heat (0.0) — without pin it would be
      // evicted first. Pin protection must skip it and evict the higher-heat
      // non-pinned peer instead.
      const PIN = fm(PIN_ID, "PIN lowest heat survivor pinheatprobe aaa locked", true);
      const PLAIN = fm(PLAIN_ID, "PLAIN higher heat evictee pinheatprobe bbb droppable");
      await seed([PIN, PLAIN]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 300, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === PIN_ID) m.set(PIN_ID, 0.0);
          if (e.mdId === PLAIN_ID) m.set(PLAIN_ID, 0.9);
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming pinheatprobe ccc trigger overflow xxxxx");
      assert.ok(result.success, result.error);

      assert.equal(result.evicted_count, 1);
      assert.deepEqual(result.evicted_md_ids, [PLAIN_ID], "higher-heat non-pinned evicted, NOT the pinned lowest-heat");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("PIN lowest heat survivor")), "pinned entry survives despite heat 0");
      assert.ok(!entries.some((e) => e.includes("PLAIN higher heat")), "non-pinned peer evicted");
    });

    it("add floor: a legacy comment-shape entry (no mdId) is evicted LAST behind scored entries", async () => {
      // A legacy comment-shape entry has NO mdId → unscoreable → heat +Infinity
      // (evict LAST). Two scored frontmatter entries (LOW/HIGH) are evicted
      // first; the legacy entry survives until every scored entry is gone.
      const LOW_ID = "88888888-8888-4888-8888-888888888888";
      const HIGH_ID = "99999999-9999-4999-8999-999999999999";
      const LEGACY = encodeRaw("LEGACY unscored survivor legacyprobe aaa no id comment shape");
      const LOW = fm(LOW_ID, "LOW scored evictee legacyprobe bbb low heat drop first");
      const HIGH = fm(HIGH_ID, "HIGH scored evictee legacyprobe ccc higher heat drop second");
      await seed([LEGACY, LOW, HIGH]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 360, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === LOW_ID) m.set(LOW_ID, 0.1);
          if (e.mdId === HIGH_ID) m.set(HIGH_ID, 0.5);
        }
        return m; // LEGACY has no mdId → never in inputs → +Infinity in the store
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming legacyprobe ddd trigger overflow xxxxxxx");
      assert.ok(result.success, result.error);

      // Both SCORED entries evicted (ascending); the unscored legacy survives.
      assert.deepEqual(result.evicted_md_ids, [LOW_ID, HIGH_ID], "scored entries evicted ascending before the legacy");
      assert.ok(!result.evicted_md_ids.includes(undefined as never), "legacy (no mdId) never appears in evicted_md_ids");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("LEGACY unscored survivor")), "legacy unscoreable entry survives until all scored are evicted");
    });

    it("add floor: NO provider → EXACT FIFO/file-order (disable-path parity)", async () => {
      // No setHeatForEntriesProvider → computeHeats returns null → the floor
      // degenerates to lowest-file-position non-pinned (pre-Task-4 FIFO).
      const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const C_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const A = fm(A_ID, "A oldest fifoprobe aaa first on disk evicted first");
      const B = fm(B_ID, "B middle fifoprobe bbb second on disk");
      const C = fm(C_ID, "C newest fifoprobe ccc last on disk survives");
      await seed([A, B, C]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 340, memoryOverflowStrategy: "vault-offload" }));
      // NOTE: no provider wired — this is the disable path.
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming fifoprobe ddd trigger overflow xxxxxxxx");
      assert.ok(result.success, result.error);

      // FIFO: oldest (A) then B; C (newest) survives.
      assert.deepEqual(result.evicted_md_ids, [A_ID, B_ID], "file-order: oldest first (disable-path FIFO parity)");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("C newest")), "newest survives");
    });

    it("add floor: a THROWING provider → FIFO (best-effort, never crashes)", async () => {
      const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const A = fm(A_ID, "A oldest throwprobe aaa first on disk");
      const B = fm(B_ID, "B newer throwprobe bbb second on disk");
      await seed([A, B]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 300, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async () => {
        throw new Error("provider boom");
      });
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming throwprobe ccc trigger overflow xxxxxxxx");
      assert.ok(result.success, result.error); // no crash
      assert.deepEqual(result.evicted_md_ids, [A_ID], "throwing provider falls back to FIFO (oldest evicted)");
    });

    it("add floor: an EMPTY-Map provider → FIFO", async () => {
      const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const A = fm(A_ID, "A oldest emptymapproobe aaa first on disk");
      const B = fm(B_ID, "B newer emptymapproobe bbb second on disk");
      await seed([A, B]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 300, memoryOverflowStrategy: "vault-offload" }));
      store.setHeatForEntriesProvider(async () => new Map());
      await store.loadFromDisk();

      const result = await store.add("memory", "NEW incoming emptymapproobe ccc trigger overflow xxxx");
      assert.ok(result.success, result.error);
      assert.deepEqual(result.evicted_md_ids, [A_ID], "empty Map falls back to FIFO (oldest evicted)");
    });

    // ── vaultOffloadAndReplace (the replace() overflow floor) ──

    it("replace floor: evicts the LOWEST-heat OTHER entry (protected entry spared; heat beats file-order)", async () => {
      // File order: A(protected) B(hotter, oldest-other) C(coldest, newest).
      // FIFO would evict B (oldest other); HEAT must evict C (coldest) instead —
      // proving heat-order overrides file-order in the replace floor too.
      const A_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
      const B_ID = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
      const C_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
      const A = fm(A_ID, "A protected replheatprobe aaa will be grown replaced");
      const B = fm(B_ID, "B hotter oldestother replheatprobe bbb fileorder would pick");
      const C = fm(C_ID, "C coldest newestother replheatprobe ccc heat picks me");
      await seed([A, B, C]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 360, memoryOverflowStrategy: "auto-consolidate" }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === A_ID) m.set(A_ID, 0.9);
          if (e.mdId === B_ID) m.set(B_ID, 0.9);
          if (e.mdId === C_ID) m.set(C_ID, 0.1);
        }
        return m;
      });
      // No consolidator → replace overflow falls straight to vaultOffloadAndReplace.
      await store.loadFromDisk();

      // Grow A so the replacement overflows by one OTHER entry.
      const grown = "A protected replheatprobe aaa GROWN to overflow the limit zzzzzzzzzzzzzzzzzzzzzzzzzzzz";
      const result = await store.replace("memory", "A protected replheatprobe aaa will be grown replaced", grown);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [C_ID], "coldest OTHER (C) evicted, NOT the file-order-oldest other (B)");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("GROWN to overflow")), "grown replacement landed");
      assert.ok(entries.some((e) => e.includes("B hotter oldestother")), "hotter other (B) survives");
      assert.ok(!entries.some((e) => e.includes("C coldest newestother")), "coldest other (C) evicted");
    });

    it("replace floor: NO provider → file-order (oldest OTHER evicted; disable-path parity)", async () => {
      const A_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
      const B_ID = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
      const C_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
      const A = fm(A_ID, "A protected replfifoprobe aaa will be grown replaced");
      const B = fm(B_ID, "B oldestother replfifoprobe bbb fileorder picks me");
      const C = fm(C_ID, "C newestother replfifoprobe ccc survives");
      await seed([A, B, C]);

      const store = new MemoryStore(makeConfig({ memoryCharLimit: 360, memoryOverflowStrategy: "auto-consolidate" }));
      // NOTE: no provider — disable path → file-order.
      await store.loadFromDisk();

      const grown = "A protected replfifoprobe aaa GROWN to overflow the limit zzzzzzzzzzzzzzzzzzzzzzzzzzzz";
      const result = await store.replace("memory", "A protected replfifoprobe aaa will be grown replaced", grown);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [B_ID], "file-order: oldest OTHER (B) evicted (disable-path parity)");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("C newestother")), "newest other (C) survives");
    });
  });

  // ── Task 5: consolidator snapshot heat-sort (baseHash-safe, prompt-free) ──
  // The 2-phase consolidator feeds the LLM a ConsolidationSnapshot; when a heat
  // provider is wired, consolidateTwoPhase fetches heats + passes them to
  // buildSnapshot so the snapshot.entries are ordered lowest-heat-first (a
  // positional nudge — no prompt change). When the provider is absent (the
  // decay-disable path), buildSnapshot gets NO heats → entry order is
  // byte-identical to pre-#1b (parse/file order). snapshotBaseHash is
  // order-insensitive, so the reconcile-write is unaffected (asserted
  // exhaustively in src/store/merge-plan.test.ts). The snapshot contains
  // exactly the seeded entries because _addInner returns its needsConsolidation
  // sentinel BEFORE persisting the overflowing new entry.
  describe("consolidator snapshot heat-sort (UPSP §1, Task 5)", () => {
    const TODAY = new Date().toISOString().split("T")[0];
    const fm = (id: string, body: string) =>
      serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY });
    async function seed(entries: string[]): Promise<void> {
      await fs.writeFile(path.join(MEMORY_DIR, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
    }

    it("passes heat-SORTED snapshot entries to the consolidator when a provider is wired", async () => {
      const HOT_ID = "11111111-1111-4111-8111-111111111111";
      const COLD_ID = "33333333-3333-4333-8333-333333333333";
      const WARM_ID = "22222222-2222-4222-8222-222222222222";
      const HOT = fm(HOT_ID, "HOT survivor snapsortprobe aaa high heat value stays");
      const COLD = fm(COLD_ID, "COLD evictee snapsortprobe bbb low heat drop me now");
      const WARM = fm(WARM_ID, "WARM middle snapsortprobe ccc medium heat ground");
      // file order: HOT, COLD, WARM (deliberately NOT heat order).
      await seed([HOT, COLD, WARM]);

      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 380,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === HOT_ID) m.set(HOT_ID, 0.9);
          if (e.mdId === COLD_ID) m.set(COLD_ID, 0.1);
          if (e.mdId === WARM_ID) m.set(WARM_ID, 0.5);
        }
        return m;
      });
      let captured: string[] = [];
      store.setConsolidator(async (snapshot) => {
        captured = snapshot.entries.map((e) => e.content);
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();
      // 4th add overflows → consolidateTwoPhase builds a snapshot over the 3
      // seeded entries (NEW is not persisted until after the plan); the
      // consolidator captures the (heat-sorted) entry order.
      await store.add("memory", "NEW incoming snapsortprobe ddd trigger overflow");
      // Heat-ascending: COLD (0.1) → WARM (0.5) → HOT (0.9).
      assert.deepEqual(
        captured,
        ["COLD evictee snapsortprobe bbb low heat drop me now", "WARM middle snapsortprobe ccc medium heat ground", "HOT survivor snapsortprobe aaa high heat value stays"],
        `snapshot entries must be heat-sorted ascending when a provider is wired; got ${JSON.stringify(captured)}`,
      );
    });

    it("passes entries in ORIGINAL (file) order when NO provider is wired (disable-path parity)", async () => {
      const HOT_ID = "11111111-1111-4111-8111-111111111111";
      const COLD_ID = "33333333-3333-4333-8333-333333333333";
      const WARM_ID = "22222222-2222-4222-8222-222222222222";
      const HOT = fm(HOT_ID, "HOT survivor snapsortfifo aaa high heat value stays");
      const COLD = fm(COLD_ID, "COLD evictee snapsortfifo bbb low heat drop me now");
      const WARM = fm(WARM_ID, "WARM middle snapsortfifo ccc medium heat ground");
      await seed([HOT, COLD, WARM]);

      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 380,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      // NOTE: no provider wired — this is the decay-disable path.
      let captured: string[] = [];
      store.setConsolidator(async (snapshot) => {
        captured = snapshot.entries.map((e) => e.content);
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();
      await store.add("memory", "NEW incoming snapsortfifo ddd trigger overflow");
      // File/parse order preserved (no sort): HOT, COLD, WARM.
      assert.deepEqual(
        captured,
        ["HOT survivor snapsortfifo aaa high heat value stays", "COLD evictee snapsortfifo bbb low heat drop me now", "WARM middle snapsortfifo ccc medium heat ground"],
        `snapshot entries must keep file order when no provider is wired (disable-path parity); got ${JSON.stringify(captured)}`,
      );
    });
  });

  // ─── Candidate-limit seam on consolidateTwoPhase (proactive-consolidation Task 2) ──
  // An optional `candidates?: string[]` param lets a proactive caller (Task 3's
  // maybeProactiveConsolidate) feed the consolidator only the decayed low-heat
  // tail instead of the whole store. When supplied, the snapshot is limited to
  // those entries; when absent, behavior is byte-identical to the overflow path
  // (the load-bearing backward-compat invariant — proven by every pre-existing
  // consolidation/overflow test passing unmodified).
  describe("candidate-limit seam (proactive-consolidation Task 2)", () => {
    const TODAY = new Date().toISOString().split("T")[0];
    const fm = (id: string, body: string) =>
      serializeMetadataFrontmatter({ id, text: body, created: TODAY, last: TODAY });
    async function seed(entries: string[]): Promise<void> {
      await fs.writeFile(path.join(MEMORY_DIR, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
    }

    it("candidates filter limits the snapshot to those entries", async () => {
      const A = fm("11111111-1111-4111-8111-111111111111", "A candprobe alpha kept-off-snapshot");
      const B = fm("22222222-2222-4222-8222-222222222222", "B candprobe bravo kept-off-snapshot");
      const C = fm("33333333-3333-4333-8333-333333333333", "C candprobe charlie on-snapshot");
      const D = fm("44444444-4444-4444-8444-444444444444", "D candprobe delta on-snapshot");
      await seed([A, B, C, D]);

      const store = new MemoryStore(makeConfig({
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      let seen: string[] = [];
      store.setConsolidator(async (snapshot) => {
        seen = snapshot.entries.map((e) => e.content);
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      }, "test");
      await store.loadFromDisk();

      // Pass only C + D as candidates → snapshot must contain exactly those two.
      await store.runConsolidatorForTest("memory", undefined, undefined, [C, D]);

      assert.deepEqual(
        seen.slice().sort(),
        ["C candprobe charlie on-snapshot", "D candprobe delta on-snapshot"].sort(),
        `candidates must limit the snapshot to C + D; got ${JSON.stringify(seen)}`,
      );
      assert.ok(!seen.includes("A candprobe alpha kept-off-snapshot"), "A must be excluded by the candidates filter");
      assert.ok(!seen.includes("B candprobe bravo kept-off-snapshot"), "B must be excluded by the candidates filter");
    });

    it("absent candidates uses ALL consolidatable entries (parity — unchanged behavior)", async () => {
      const A = fm("11111111-1111-4111-8111-111111111111", "A absentprobe alpha full-snapshot");
      const B = fm("22222222-2222-4222-8222-222222222222", "B absentprobe bravo full-snapshot");
      await seed([A, B]);

      const store = new MemoryStore(makeConfig({
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      let seen: string[] = [];
      store.setConsolidator(async (snapshot) => {
        seen = snapshot.entries.map((e) => e.content);
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      }, "test");
      await store.loadFromDisk();

      // No candidates → derive consolidatable exactly as the overflow path does
      // (all entries, none pinned) → snapshot contains both.
      await store.runConsolidatorForTest("memory");

      assert.equal(seen.length, 2, `absent candidates must use all entries; got ${JSON.stringify(seen)}`);
      assert.deepEqual(
        seen.slice().sort(),
        ["A absentprobe alpha full-snapshot", "B absentprobe bravo full-snapshot"].sort(),
      );
    });
  });

  // ─── remove() tests ───

  describe("remove()", () => {
    it("removes entry from file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} to be removed`);
      await store.add("memory", `${TEST_MARKER} to keep`);

      const result = await store.remove("memory", `${TEST_MARKER} to be removed`);

      assert.ok(result.success);
      assert.equal(result.message, "Entry removed.");
      assert.equal(result.entry_count, 1);
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} to be removed`));
      assert.ok(raw.includes(`${TEST_MARKER} to keep`));
    });

    it("accepts a pasted memory_search line for normal memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} prefers pnpm over npm`);

      const result = await store.remove("memory", `🧠 [global] ${TEST_MARKER} prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27`);

      assert.ok(result.success);
      const raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });

    it("accepts a pasted memory_search line for failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });

      const result = await store.remove(
        "failure",
        `⚠️ [global] [correction] [correction] ${TEST_MARKER} use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27`,
      );

      assert.ok(result.success);
      const raw = await readRaw(failurePath);
      assert.equal(raw.trim(), "");
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);

      const result = await store.remove("memory", "nonexistent");

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.remove("memory", "  ");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });
  });

  // ─── loadFromDisk() tests ───

  describe("loadFromDisk()", () => {
    it("reads existing MEMORY.md and USER.md correctly", async () => {
      // beforeEach already cleaned slate; write test data
      await writeRaw(memoryPath, `${TEST_MARKER} mem entry 1${ENTRY_DELIMITER}${TEST_MARKER} mem entry 2`);
      await writeRaw(userPath, `${TEST_MARKER} user entry 1`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const memEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();

      assert.deepEqual(memEntries, [`${TEST_MARKER} mem entry 1`, `${TEST_MARKER} mem entry 2`]);
      assert.deepEqual(userEntries, [`${TEST_MARKER} user entry 1`]);
    });

    it("handles missing files gracefully (returns empty)", async () => {
      // beforeEach cleaned slate — files should not exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      assert.deepEqual(store.getMemoryEntries(), []);
      assert.deepEqual(store.getUserEntries(), []);
    });

    it("deduplicates entries preserving order", async () => {
      const entry1 = `${TEST_MARKER} dup original`;
      const entry2 = `${TEST_MARKER} dup second`;
      const entry3 = `${TEST_MARKER} dup third`;

      await writeRaw(memoryPath, [entry1, entry2, entry1, entry3].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = store.getMemoryEntries();
      assert.deepEqual(entries, [entry1, entry2, entry3]);
    });
  });

  // ─── formatForSystemPrompt() tests ───

  describe("formatForSystemPrompt()", () => {
    it("returns frozen snapshot — add after load does not change it", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} original note`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const before = store.formatForSystemPrompt();
      assert.ok(before.includes(`${TEST_MARKER} original note`));

      // Add a new entry — this should NOT affect the snapshot
      await store.add("memory", `${TEST_MARKER} new note after load`);

      const after = store.formatForSystemPrompt();
      assert.equal(before, after, "Snapshot should not change after add");
      assert.ok(!after.includes(`${TEST_MARKER} new note after load`));
    });

    it("returns empty string when no entries", async () => {
      // beforeEach cleaned slate — no entries exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.equal(result, "");
    });

    it("injects recent failure memories by default", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} failure 1`),
        failureEntry(`${TEST_MARKER} failure 2`),
        failureEntry(`${TEST_MARKER} failure 3`),
        failureEntry(`${TEST_MARKER} failure 4`),
        failureEntry(`${TEST_MARKER} failure 5`),
        failureEntry(`${TEST_MARKER} failure 6`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(result.includes(`${TEST_MARKER} failure 1`));
      assert.ok(result.includes(`${TEST_MARKER} failure 5`));
      assert.ok(!result.includes(`${TEST_MARKER} failure 6`), "default should preserve existing first-5 slice behavior");
    });

    it("does not inject failure memories when disabled", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} regular memory`);
      await writeRaw(failurePath, failureEntry(`${TEST_MARKER} disabled failure`));

      const store = new MemoryStore(makeConfig({ failureInjectionEnabled: false }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} regular memory`));
      assert.ok(!result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(!result.includes(`${TEST_MARKER} disabled failure`));
    });

    it("respects configured failure injection max entries", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} max entry 1`),
        failureEntry(`${TEST_MARKER} max entry 2`),
        failureEntry(`${TEST_MARKER} max entry 3`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxEntries: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} max entry 1`));
      assert.ok(result.includes(`${TEST_MARKER} max entry 2`));
      assert.ok(!result.includes(`${TEST_MARKER} max entry 3`));
    });

    it("respects configured failure injection max age days", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} recent failure`, 1),
        failureEntry(`${TEST_MARKER} old failure`, 3),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxAgeDays: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} recent failure`));
      assert.ok(!result.includes(`${TEST_MARKER} old failure`));
    });

    it("includes both memory and user blocks when both have entries", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} mem data`);
      await writeRaw(userPath, `${TEST_MARKER} user data`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      // Content should be present inside fenced blocks
      assert.ok(result.includes("<memory-context>"), "should use context fencing");
      assert.ok(result.includes("PERSISTENT MEMORY"), "should have guard note");
      assert.ok(result.includes("NOT new user input"), "should disclaim as not user input");
      assert.ok(result.includes("END MEMORY"), "should close fence");
      assert.ok(result.includes("</memory-context>"), "should close XML tag");
      assert.ok(result.includes("MEMORY"), "should contain MEMORY header");
      assert.ok(result.includes("USER PROFILE"), "should contain USER PROFILE header");
      assert.ok(result.includes(`${TEST_MARKER} mem data`));
      assert.ok(result.includes(`${TEST_MARKER} user data`));
    });
  });

  // ─── Atomic writes ───

  describe("atomic writes", () => {
    it("file content is correct after write (read back and check)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = [
        `${TEST_MARKER} first atomic entry`,
        `${TEST_MARKER} second atomic entry`,
      ];

      await store.add("memory", entries[0]);
      await store.add("memory", entries[1]);


      const raw = await readRaw(memoryPath);
      const parsed = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);

      // Strip frontmatter metadata for comparison (Task 7: births emit YAML
      // frontmatter id/created/last + body — the legacy trailing HTML comment
      // shape is retired for births; legacy comment entries are still parsed).
      const stripped = parsed.map((e) => e.replace(/^---\n[\s\S]*?\n---\n/, "").trim());
      assert.deepEqual(stripped, entries);
    });

    it("file is empty after all entries are removed", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} temporary entry`);

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      await store.remove("memory", `${TEST_MARKER} temporary entry`);

      raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });
  });

  // ─── Both targets ───

  describe("both targets", () => {
    it("add to 'user' goes to USER.md, add to 'memory' goes to MEMORY.md", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("user", `${TEST_MARKER} user fact`);
      await store.add("memory", `${TEST_MARKER} memory fact`);

      const userRaw = await readRaw(userPath);
      const memRaw = await readRaw(memoryPath);

      assert.ok(userRaw.includes(`${TEST_MARKER} user fact`));
      assert.ok(!userRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(memRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(!memRaw.includes(`${TEST_MARKER} user fact`));
    });
  });

  // ─── Reload-before-write (external mutation visibility) ───
  //
  // Reproduces the stale MemoryStore cache bug: the store caches entries in
  // memory at loadFromDisk() time. If the underlying .md is shrunk externally
  // mid-session (cross-session edit, offline dedup that rewrote the .md, a
  // regenerated file) the in-memory charCount goes stale and a subsequent add
  // is wrongly rejected with the OLD count. The fix reloads from disk before
  // the capacity check, so charCount reflects on-disk state at write time.
  describe("reload-before-write (external mutation visibility)", () => {
    it("add() succeeds after the .md is externally shrunk mid-session (no stale-count reject)", async () => {
      // Pick a limit where `big` fits alone, but `big` + `fresh` would exceed —
      // so before the shrink the add would be rejected, after the shrink it fits.
      const limit = 200;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      const big = `${TEST_MARKER} ${"x".repeat(100)}`;
      assert.ok((await store.add("memory", big)).success, "big entry should fit initially");

      // EXTERNALLY shrink the file (simulate cross-session removal / dedup that
      // rewrote the .md). This does NOT refresh the in-memory cache.
      await writeRaw(memoryPath, "");

      // The cache is still stale (reflects pre-shrink content) — proves the
      // external edit did not auto-refresh the store.
      assert.ok(store.charCount("memory") > 0, "in-memory cache should be stale (still reflects pre-shrink content)");

      // A new entry that could NOT have fit before the shrink but CAN after.
      const fresh = `${TEST_MARKER} fresh after external shrink`;
      const result = await store.add("memory", fresh);

      assert.ok(result.success, `Expected add to succeed after external shrink, but got: ${result.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(fresh), "fresh entry should be persisted");
      assert.ok(!raw.includes(big), "externally-removed entry should stay gone");
    });

    it("charCount reflects on-disk state at write time, not the startup snapshot", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 500 }));
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} alpha`);
      const countAfterFirstLoad = store.charCount("memory");
      assert.ok(countAfterFirstLoad > 0);

      // Externally rewrite the file with different content.
      await writeRaw(memoryPath, `${TEST_MARKER} externally rewritten`);

      // Trigger an op whose reload-path refreshes in-memory state (replace
      // reloads at its top even though the lookup below won't match).
      await store.replace("memory", "nonexistent-marker-xyz", `${TEST_MARKER} nope`).catch(() => {});

      const memEntries = store.getMemoryEntries();
      assert.ok(
        memEntries.some((e) => e.includes("externally rewritten")),
        `entries/charCount should reflect the external rewrite; got: ${JSON.stringify(memEntries)}`,
      );
      assert.notEqual(store.charCount("memory"), countAfterFirstLoad);
    });

    it("replace() sees an externally-added entry mid-session", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      // Externally add an entry the store does not yet know about.
      await writeRaw(memoryPath, `${TEST_MARKER} externally added line`);

      // Without reload, replace could not match it (stale empty cache).
      const result = await store.replace("memory", "externally added line", `${TEST_MARKER} externally replaced line`);

      assert.ok(result.success, `Expected replace to see the externally-added entry, but got: ${result.error}`);
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes("externally replaced line"));
      assert.ok(!raw.includes("externally added line"));
    });

    it("concurrent same-session adds do not lose data (reload does not clobber in-flight writes)", async () => {
      // The reload-before-write fix must not break concurrent writes in the same
      // session: two adds issued without awaiting must both land. Guards the
      // "reload must not clobber a concurrent in-flight write" edge case.
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const [a, b] = await Promise.all([
        store.add("memory", `${TEST_MARKER} concurrent A`),
        store.add("memory", `${TEST_MARKER} concurrent B`),
      ]);

      assert.ok(a.success, `concurrent A failed: ${a.error}`);
      assert.ok(b.success, `concurrent B failed: ${b.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} concurrent A`), "concurrent A should persist");
      assert.ok(raw.includes(`${TEST_MARKER} concurrent B`), "concurrent B should persist");
    });
  });

  describe("cross-process file lock (withFileLock)", () => {
    /** True iff a lock directory exists for the given source file. */
    async function lockExists(srcPath: string): Promise<boolean> {
      try { await fs.stat(`${srcPath}.lock`); return true; } catch { return false; }
    }

    it("acquires the lock during a write, then releases it (no leftover .lock dir)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      assert.equal(await lockExists(memoryPath), false, "no lock before write");
      assert.ok((await store.add("memory", `${TEST_MARKER} lock-release`)).success);
      assert.equal(await lockExists(memoryPath), false, "lock released after write");
      assert.ok((await readRaw(memoryPath)).includes("lock-release"));
    });

    it("PI_MEMORY_FILE_LOCK=bypass skips the cross-process lock (consolidator child path)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      const prev = process.env.PI_MEMORY_FILE_LOCK;
      process.env.PI_MEMORY_FILE_LOCK = "bypass";
      try {
        assert.ok((await store.add("memory", `${TEST_MARKER} bypass-no-lock`)).success);
        assert.equal(await lockExists(memoryPath), false, "bypass must not create a lock dir");
      } finally {
        if (prev === undefined) delete process.env.PI_MEMORY_FILE_LOCK;
        else process.env.PI_MEMORY_FILE_LOCK = prev;
      }
      assert.ok((await readRaw(memoryPath)).includes("bypass-no-lock"));
    });

    it("serializes concurrent writes from two store instances on the same .md (no lost update)", async () => {
      // THE core cross-process guarantee: two store instances (simulating two
      // sessions) writing the same .md concurrently must BOTH land. Without
      // withFileLock, loadFromDisk→saveToDisk races → last-writer-wins → one is
      // lost. With the lock, instance B blocks on the lockfile until A releases,
      // then reloads (seeing A's entry) and appends.
      const storeA = new MemoryStore(makeConfig());
      const storeB = new MemoryStore(makeConfig());
      await storeA.loadFromDisk();
      await storeB.loadFromDisk();

      const [a, b] = await Promise.all([
        storeA.add("memory", `${TEST_MARKER} cross-instance A`),
        storeB.add("memory", `${TEST_MARKER} cross-instance B`),
      ]);
      assert.ok(a.success, `A failed: ${a.error}`);
      assert.ok(b.success, `B failed: ${b.error}`);

      await storeA.loadFromDisk();
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes("cross-instance A"), "A's entry must persist (no lost update)");
      assert.ok(raw.includes("cross-instance B"), "B's entry must persist (no lost update)");
    });

    it("retries the whole operation when cross-process lock acquisition throws ELOCKED (no lost write)", async () => {
      // A second session ("blocker") holds the MEMORY.md lock with a long stale so
      // the store's acquisition ELOCKEDs, then releases it after a short delay.
      // The store (lockAcquireRetries:0 → instant ELOCKED; lockOpRetries high) must
      // re-attempt the whole lock+critical-section and land the entry once free.
      // Without the op-level retry the FIRST ELOCKED would reject the add and the
      // write would be lost — exactly the cross-session contention regression.
      const blockerPath = path.join(MEMORY_DIR, MEMORY_FILE);
      const releaseBlocker = await lockfile.lock(blockerPath, { stale: 60_000, realpath: false });
      const releaseTimer = setTimeout(() => void releaseBlocker().catch(() => {}), 300);
      try {
        const store = new MemoryStore(makeConfig({
          lockAcquireRetries: 0, // fail-fast on the held lock → ELOCKED immediately
          lockOpRetries: 12,
          lockOpBackoffMs: 40,
        }));
        await store.loadFromDisk();
        const res = await store.add("memory", `${TEST_MARKER} op-retry-wins`);
        assert.ok(res.success, `expected success after op-retry, got: ${res.error}`);

        await store.loadFromDisk();
        const raw = await readRaw(blockerPath);
        assert.ok(raw.includes("op-retry-wins"), "entry must land after op-retry (no lost write)");
      } finally {
        clearTimeout(releaseTimer);
        await releaseBlocker().catch(() => {});
      }
    });

    it("surfaces the lock error (not a silent loss) after op-retries are exhausted", async () => {
      // Blocker holds the lock for the whole test → every acquire ELOCKEDs → after
      // lockOpRetries the add rejects. The write is NOT silently lost; the caller
      // sees a clear lock error to retry.
      const blockerPath = path.join(MEMORY_DIR, MEMORY_FILE);
      const releaseBlocker = await lockfile.lock(blockerPath, { stale: 60_000, realpath: false });
      try {
        const store = new MemoryStore(makeConfig({
          lockAcquireRetries: 0,
          lockOpRetries: 2,
          lockOpBackoffMs: 20,
        }));
        await store.loadFromDisk();
        await assert.rejects(
          () => store.add("memory", `${TEST_MARKER} op-retry-exhausted`),
          /lock file is already|already being held|ELOCKED/i,
        );
      } finally {
        await releaseBlocker().catch(() => {});
      }
    });

    it("runConsolidator leaves PI_MEMORY_FILE_LOCK UNSET (2-phase drops the bypass toggle), then the store still saves via the floor", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      let envDuringConsolidation: string | undefined = "<not called>";
      store.setConsolidator(async (snapshot) => {
        // 2-phase no longer sets PI_MEMORY_FILE_LOCK=bypass: step 2 is lock-free
        // and step 3 acquires the lock normally, so there is no held lock to bypass.
        envDuringConsolidation = process.env.PI_MEMORY_FILE_LOCK;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();
      const prev = process.env.PI_MEMORY_FILE_LOCK;

      await store.add("memory", `${TEST_MARKER} consolidate env 1`);
      await store.add("memory", `${TEST_MARKER} consolidate env 2`);
      // third overflows → auto-consolidate → runConsolidator wraps the plan step
      const result = await store.add("memory", `${TEST_MARKER} consolidate env 3`);

      assert.equal(envDuringConsolidation, prev,
        `PI_MEMORY_FILE_LOCK must NOT be set to bypass during consolidation; got ${envDuringConsolidation}`);
      assert.equal(process.env.PI_MEMORY_FILE_LOCK, prev, "env unchanged after consolidation");
      assert.ok(result.success, `floor should still save (never-reject): ${result.error}`);
    });

    it("runConsolidator sets PI_HERMES_CONSOLIDATING=1 for the child (prevents nested consolidation), then restores it", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      let envDuringConsolidation: string | undefined = "<not called>";
      store.setConsolidator(async (snapshot) => {
        envDuringConsolidation = process.env.PI_HERMES_CONSOLIDATING;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      });
      await store.loadFromDisk();
      const prev = process.env.PI_HERMES_CONSOLIDATING;

      await store.add("memory", `${TEST_MARKER} consol-flag 1`);
      await store.add("memory", `${TEST_MARKER} consol-flag 2`);
      await store.add("memory", `${TEST_MARKER} consol-flag 3`); // overflow → runConsolidator

      assert.equal(envDuringConsolidation, "1",
        `consolidator child must inherit PI_HERMES_CONSOLIDATING=1; got ${envDuringConsolidation}`);
      assert.equal(process.env.PI_HERMES_CONSOLIDATING, prev, "env restored after consolidation");
    });

    it("fires onProgress with the consolidator model label when consolidation runs", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      const progress: string[] = [];
      // Stub consolidator + a model label (as index.ts injects in production).
      store.setConsolidator(async (snapshot) => ({ plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }), "bonsai-27b");
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} progress 1`);
      await store.add("memory", `${TEST_MARKER} progress 2`);
      // third overflows -> auto-consolidate -> runConsolidator fires onProgress
      await store.add("memory", `${TEST_MARKER} progress 3`, { onProgress: (m) => progress.push(m) });

      assert.ok(progress.length > 0, "onProgress should fire when consolidation runs");
      assert.ok(
        progress.some((m) => m.includes("bonsai-27b")),
        `progress message should include the consolidator model label; got: ${JSON.stringify(progress)}`,
      );
      assert.ok(
        progress.some((m) => /consolidat/i.test(m)),
        `progress message should describe consolidation; got: ${JSON.stringify(progress)}`,
      );
    });
  });

  // ── Task 5: 2-phase consolidation update-safety race gate ──────────────
  // These tests are the ACCEPTANCE GATE for the 2-phase restructure (Task 4).
  // They prove that entries a concurrent session writes to disk while step 2
  // (the lock-free LLM plan) is running are PRESERVED by step 3's reconcile,
  // and that a plan op referencing an entry removed mid-flight is skipped (not
  // an error). If Task 4's consolidateTwoPhase failed to re-read disk in step 3
  // (or applyMergePlan dropped unreferenced live entries), the appended entry in
  // test 1 would VANISH and these assertions would FAIL — do NOT weaken them.
  describe("2-phase consolidation: update-safety race gate (Task 5)", () => {
    // Sizing rationale (constants, not magic numbers):
    //   • store.add() writes YAML frontmatter (5d stable-id shape). A bare entry
    //     is ~body + 86 chars: "---\nid: <36-char uuid>\ncreated: <d>\nlast: <d>\n---\n".
    //     (The pre-migration comment shape was body + ~45; frontmatter is +41/entry.)
    //   • The race stub's concurrent append (encodeRaw) is still comment-shape
    //     (body + ~45) — kept legacy-shape deliberately so the test also pins the
    //     migration's claim that a mixed frontmatter+comment file reconciles cleanly.
    //   • ENTRY_DELIMITER ("\n§\n") is 3 chars between entries.

    it("RACE: an entry appended during step 2 (lock-free) is preserved after reconcile", async () => {
      const limit = 350;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: limit,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();

      // Seed two entries. `first` is large so that adding `incoming` overflows;
      // the plan drops `first` (snapshot.entries[0]) so `second` survives.
      const first = `${TEST_MARKER} ${"A".repeat(70)}`;            // fm 170 (body 84 + 86)
      const second = `${TEST_MARKER} keep second seeded`;          // fm 118
      const incoming = `${TEST_MARKER} incoming third probe`;      // fm 120
      // Overflow check:  170 + 3 + 118 + 3 + 120 = 414 > 350  ✓
      // After reconcile: [second(118), APPEND(61), incoming(120)] = 305 ≤ 350 ✓
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      // The consolidator runs in step 2 (lock-free). It appends a CONCURRENT
      // entry straight to disk (simulating a sibling session), then returns a
      // plan built against the PRE-append snapshot — so the appended entry is
      // NOT referenced by any op and MUST survive step 3's reconcile as an
      // unreferenced live entry.
      store.setConsolidator(async (snapshot) => {
        appendEntryToDisk(memoryPath, encodeRaw("CONCURRENT-APPEND"));
        const firstKey = snapshot.entries[0]?.key;
        return {
          plan: {
            snapshotBaseHash: snapshot.snapshotBaseHash,
            ops: firstKey ? [{ op: "drop" as const, key: firstKey }] : [],
          },
        };
      }, "race-stub");

      // Third add overflows → 2-phase consolidation (step 2 lock-free, with the
      // concurrent append happening mid-flight) → step 3 reconcile preserves the
      // appended entry → the retried locked write lands.
      const result = await store.add("memory", incoming);
      assert.ok(result.success, `retried add should fit after consolidation; got: ${result.error}`);

      await store.loadFromDisk(); // defensive freshness for the read-back
      const contents = store.getMemoryEntries();

      // THE invariant: the concurrently-appended entry was NOT clobbered by the
      // reconcile rewrite (step 3 re-read disk + applyMergePlan keeps live
      // entries that no applied op removes).
      assert.ok(contents.includes("CONCURRENT-APPEND"),
        `concurrently-appended entry must survive reconcile; got: ${JSON.stringify(contents)}`);
      // Sanity: the plan did drop `first`, kept `second`, and the retried add
      // landed `incoming`.
      assert.ok(!contents.some((c) => c.includes("AAAA")), "first was dropped by the merge plan");
      assert.ok(contents.some((c) => c.includes("keep second seeded")), "second preserved");
      assert.ok(contents.some((c) => c.includes("incoming third probe")), "incoming landed");
    });

    it("RACE: a plan op referencing a removed entry is skipped; consolidation completes without corrupting", async () => {
      const limit = 300;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: limit,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();

      // `first` is large (overflows when `incoming` is added); `second` is small
      // and stays under the limit once `first` is gone.
      const first = `${TEST_MARKER} ${"A".repeat(60)}`;            // fm 160 (body 74 + 86)
      const second = `${TEST_MARKER} keep`;                       // fm 104
      const incoming = `${TEST_MARKER} incoming probe`;           // fm 114
      // Overflow check:  160 + 3 + 104 + 3 + 114 = 384 > 300  ✓
      // After concurrent remove of `first` + retried add: [second(104), incoming(114)] = 221 ≤ 300 ✓
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      // During step 2, remove `first` from disk (concurrent removal) and return
      // a plan whose drop op still references `first`'s (now-absent) key plus a
      // stale base hash. applyMergePlan must SKIP the op, not throw, and the
      // store must stay consistent.
      store.setConsolidator(async (snapshot) => {
        const doomedKey = snapshot.entries[0]?.key ?? "missing";
        await removeFirstEntryFromDisk(memoryPath); // simulate concurrent removal
        return { plan: { snapshotBaseHash: "stale", ops: [{ op: "drop" as const, key: doomedKey }] } };
      }, "race-stub");

      // No throw: the stale op is skipped, the reconcile writes back the live
      // state, and the retried add fits.
      const result = await store.add("memory", incoming);
      assert.ok(result.success, `consolidation must complete despite the stale op; got: ${result.error}`);

      // Store consistent: under limit (+ one-entry slack), parses cleanly, and
      // holds exactly the entries that should remain.
      const total = await totalCharsOnDisk(memoryPath);
      assert.ok(total <= limit + 90, `store over budget after race: ${total} > ${limit}+90`);
      await store.loadFromDisk();
      const contents = store.getMemoryEntries();
      assert.ok(!contents.some((c) => c.includes("AAAA")), "concurrently-removed first stays gone");
      assert.ok(contents.some((c) => c.includes("keep")), "second preserved");
      assert.ok(contents.some((c) => c.includes("incoming probe")), "incoming landed");
    });
  });

  // ─── Failure lifecycle: state/severity (Task 5) ───

  describe("failure lifecycle injection filter", () => {
    it("formatForSystemPrompt injects ONLY active failures (excludes resolved/acquired)", async () => {
      await writeRaw(failurePath, [
        frontmatterFailureEntry(`${TEST_MARKER} live failure`, { state: "active" }),
        frontmatterFailureEntry(`${TEST_MARKER} fixed failure`, { state: "resolved" }),
        frontmatterFailureEntry(`${TEST_MARKER} known quirk`, { state: "acquired" }),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} live failure`), "active failure must be injected");
      assert.ok(!result.includes(`${TEST_MARKER} fixed failure`), "resolved failure must NOT be injected");
      assert.ok(!result.includes(`${TEST_MARKER} known quirk`), "acquired failure must NOT be injected");
    });

    it("getActiveFailureEntries surfaces active only; getFailureEntries stays age-only (dedup sees resolved/acquired)", async () => {
      await writeRaw(failurePath, [
        frontmatterFailureEntry(`${TEST_MARKER} active`, { state: "active" }),
        frontmatterFailureEntry(`${TEST_MARKER} resolved`, { state: "resolved" }),
        frontmatterFailureEntry(`${TEST_MARKER} acquired`, { state: "acquired" }),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      // Injection path (state-aware): only the active entry.
      const active = store.getActiveFailureEntries(7);
      assert.deepEqual(active, [`${TEST_MARKER} active`]);

      // Capture-dedup path (age-only): error-detector still SEES resolved/acquired
      // so it does not re-capture a known failure. (Regression guard for the
      // CRITICAL call-site-split constraint.)
      const all = store.getFailureEntries(7);
      assert.ok(all.includes(`${TEST_MARKER} active`));
      assert.ok(all.includes(`${TEST_MARKER} resolved`));
      assert.ok(all.includes(`${TEST_MARKER} acquired`));
    });

    it("a stateless (comment-shape) failure still injects — missing state reads as active", async () => {
      // Legacy comment entries carry no state; the safe default is `active`
      // (never silently hide a failure).
      await writeRaw(failurePath, failureEntry(`${TEST_MARKER} legacy failure`));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} legacy failure`));
    });
  });

  describe("failure lifecycle add default", () => {
    it("addFailure defaults state by category: tool-quirk → acquired", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} quirk`, { category: "tool-quirk" });

      // Decoded state (entriesWithMeta now carries state) …
      const meta = store.entriesWithMeta("failure");
      const hit = meta.find((m) => m.text.includes(`${TEST_MARKER} quirk`));
      assert.ok(hit, "tool-quirk entry should be present");
      assert.equal(hit!.state, "acquired");

      // … and it is actually persisted in the on-disk frontmatter.
      const raw = await readRaw(failurePath);
      assert.ok(/state: acquired/.test(raw), `frontmatter should carry state: acquired; got: ${raw}`);
    });

    it("addFailure defaults state by category: failure → active", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} boom`, { category: "failure" });

      const meta = store.entriesWithMeta("failure");
      const hit = meta.find((m) => m.text.includes(`${TEST_MARKER} boom`));
      assert.ok(hit);
      assert.equal(hit!.state, "active");

      const raw = await readRaw(failurePath);
      assert.ok(/state: active/.test(raw), `frontmatter should carry state: active; got: ${raw}`);
    });

    it("non-failure targets carry no state field (omitted for memory/user)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} plain note`);

      const meta = store.entriesWithMeta("memory");
      const hit = meta.find((m) => m.text.includes(`${TEST_MARKER} plain note`));
      assert.ok(hit);
      assert.equal(hit!.state, undefined);
      const raw = await readRaw(memoryPath);
      assert.ok(!/state:/.test(raw), "memory frontmatter must NOT carry a state field");
    });
  });

  // ─── Assembly manifest (prompt-provenance, UPSP §5) ───
  //
  // getAssemblyManifest()/getProjectAssemblyManifest() return the rendered block (byte-
  // identical to formatForSystemPrompt()/formatProjectBlock()) PLUS the md_id set of EXACTLY
  // the entries that block was assembled from. The id set and any hash over `block` must be
  // consistent by construction — that is the prompt-provenance invariant (UPSP §5). Every
  // seeded entry carries a frontmatter `id` so the manifest can harvest it. Reuses the file's
  // shared tmp-dir + makeConfig()/writeRaw() idiom (entries written to disk, then loadFromDisk).
  describe("MemoryStore assembly manifest", () => {
    it("getAssemblyManifest: block equals formatForSystemPrompt; ids = memory + user + active failure", async () => {
      const today = dateDaysAgo(0);
      const MEM_A = "a1a1a1a1-1111-1111-1111-111111111111";
      const MEM_B = "b2b2b2b2-2222-2222-2222-222222222222";
      const USR_C = "c3c3c3c3-3333-3333-3333-333333333333";
      const FAIL_D = "d4d4d4d4-4444-4444-4444-444444444444";

      // 2 memory + 1 user entry, each frontmatter-stamped with a stable id.
      await writeRaw(
        memoryPath,
        [
          serializeMetadataFrontmatter({ id: MEM_A, text: `${TEST_MARKER} asm memory one`, created: today, last: today }),
          serializeMetadataFrontmatter({ id: MEM_B, text: `${TEST_MARKER} asm memory two`, created: today, last: today }),
        ].join(ENTRY_DELIMITER),
      );
      await writeRaw(
        userPath,
        serializeMetadataFrontmatter({ id: USR_C, text: `${TEST_MARKER} asm user fact`, created: today, last: today }),
      );
      // 1 ACTIVE failure inside the max-age window → injected → its id is harvested.
      await writeRaw(
        failurePath,
        serializeMetadataFrontmatter({ id: FAIL_D, text: `${TEST_MARKER} asm failure boom`, created: today, last: today, state: "active" }),
      );

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const manifest = store.getAssemblyManifest();

      // (D2) the block is EXACTLY what the agent is injected with:
      assert.equal(manifest.block, store.formatForSystemPrompt());
      // ids are the unique md_ids of memory + user + post-filter active failures:
      assert.deepEqual(new Set(manifest.mdIds), new Set([MEM_A, MEM_B, USR_C, FAIL_D]));
    });

    it("getAssemblyManifest: failure ids are excluded when failure injection is disabled", async () => {
      const today = dateDaysAgo(0);
      const MEM_A = "e5e5e5e5-5555-5555-5555-555555555555";
      const FAIL_D = "f6f6f6f6-6666-6666-6666-666666666666";
      await writeRaw(
        memoryPath,
        serializeMetadataFrontmatter({ id: MEM_A, text: `${TEST_MARKER} asm nomem`, created: today, last: today }),
      );
      await writeRaw(
        failurePath,
        serializeMetadataFrontmatter({ id: FAIL_D, text: `${TEST_MARKER} asm nofail`, created: today, last: today, state: "active" }),
      );

      const store = new MemoryStore(makeConfig({ failureInjectionEnabled: false }));
      await store.loadFromDisk();

      const manifest = store.getAssemblyManifest();
      assert.equal(manifest.block, store.formatForSystemPrompt());
      // The failure block is NOT injected, so its id must NOT appear in the manifest.
      assert.deepEqual(new Set(manifest.mdIds), new Set([MEM_A]));
      assert.ok(!manifest.mdIds.includes(FAIL_D));
    });

    it("getAssemblyManifest: filters out non-active (resolved/acquired) and out-of-window failures", async () => {
      const today = dateDaysAgo(0);
      const ACTIVE = "11111111-aaaa-1111-1111-111111111111";
      const RESOLVED = "22222222-bbbb-2222-2222-222222222222";
      const OLD = "33333333-cccc-3333-3333-333333333333";
      await writeRaw(
        failurePath,
        [
          serializeMetadataFrontmatter({ id: ACTIVE, text: `${TEST_MARKER} asm active`, created: today, last: today, state: "active" }),
          // resolved → excluded from injection → excluded from manifest.
          serializeMetadataFrontmatter({ id: RESOLVED, text: `${TEST_MARKER} asm resolved`, created: today, last: today, state: "resolved" }),
          // active but older than the 1-day window → excluded.
          serializeMetadataFrontmatter({ id: OLD, text: `${TEST_MARKER} asm old`, created: dateDaysAgo(5), last: dateDaysAgo(5), state: "active" }),
        ].join(ENTRY_DELIMITER),
      );

      const store = new MemoryStore(makeConfig({ failureInjectionMaxAgeDays: 1, failureInjectionMaxEntries: 5 }));
      await store.loadFromDisk();

      const manifest = store.getAssemblyManifest();
      // Only the in-window ACTIVE failure is injected → only its id is harvested.
      assert.deepEqual(new Set(manifest.mdIds), new Set([ACTIVE]));
      assert.ok(!manifest.mdIds.includes(RESOLVED));
      assert.ok(!manifest.mdIds.includes(OLD));
    });

    it("getAssemblyManifest: failure id set is sliced to maxEntries (mirrors the renderer)", async () => {
      const today = dateDaysAgo(0);
      const ids = [
        "aa000000-0000-0000-0000-0000000000aa",
        "bb000000-0000-0000-0000-0000000000bb",
        "cc000000-0000-0000-0000-0000000000cc",
      ];
      await writeRaw(
        failurePath,
        ids
          .map((id) => serializeMetadataFrontmatter({ id, text: `${TEST_MARKER} asm max ${id.slice(0, 2)}`, created: today, last: today, state: "active" }))
          .join(ENTRY_DELIMITER),
      );

      const store = new MemoryStore(makeConfig({ failureInjectionMaxEntries: 2 }));
      await store.loadFromDisk();

      const manifest = store.getAssemblyManifest();
      assert.equal(manifest.block, store.formatForSystemPrompt());
      // Only the first 2 failures are injected → only their ids are harvested.
      assert.deepEqual(new Set(manifest.mdIds), new Set([ids[0], ids[1]]));
    });

    it("getProjectAssemblyManifest: block equals formatProjectBlock; ids = project memory ids", async () => {
      const today = dateDaysAgo(0);
      const PROJ_A = "1a1a1a1a-1111-1111-1111-1a1a1a1a1a1a";
      const PROJ_B = "2b2b2b2b-2222-2222-2222-2b2b2b2b2b2b";
      await writeRaw(
        memoryPath,
        [
          serializeMetadataFrontmatter({ id: PROJ_A, text: `${TEST_MARKER} asm project one`, created: today, last: today }),
          serializeMetadataFrontmatter({ id: PROJ_B, text: `${TEST_MARKER} asm project two`, created: today, last: today }),
        ].join(ENTRY_DELIMITER),
      );

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const name = "demo";
      const manifest = store.getProjectAssemblyManifest(name);
      assert.equal(manifest.block, store.formatProjectBlock(name));
      assert.deepEqual(new Set(manifest.mdIds), new Set([PROJ_A, PROJ_B]));
    });

    // ─── signatures (UPSP §9 / ticket #06, Task 1) ───
    //
    // The manifest ALSO emits `signatures: { mdId, signature }[]` — one entry per
    // surfaced md_id whose computeSignature(body, minChars) is non-null. #05's
    // { block, mdIds } are UNCHANGED (additive field). Signatures are harvested
    // in the SAME iteration that collects md_ids (DRY — no duplicated selection).
    it("getAssemblyManifest: emits one signature per qualifying surfaced md_id", async () => {
      const today = dateDaysAgo(0);
      const MEM_A = "11111111-aaaa-1111-1111-111111111111";
      const MEM_B = "22222222-bbbb-2222-2222-222222222222";
      const USR_C = "33333333-cccc-3333-3333-333333333333";
      const FAIL_D = "44444444-dddd-4444-4444-444444444444";
      const bodyA = `${TEST_MARKER} memory A body is long enough to qualify as a signature`;
      const bodyB = `${TEST_MARKER} memory B body is also sufficiently long for a signature`;
      const bodyC = `${TEST_MARKER} user fact body is long enough to count here`;
      const bodyD = `${TEST_MARKER} failure body is long enough to be signed too`;
      await writeRaw(
        memoryPath,
        [
          serializeMetadataFrontmatter({ id: MEM_A, text: bodyA, created: today, last: today }),
          serializeMetadataFrontmatter({ id: MEM_B, text: bodyB, created: today, last: today }),
        ].join(ENTRY_DELIMITER),
      );
      await writeRaw(
        userPath,
        serializeMetadataFrontmatter({ id: USR_C, text: bodyC, created: today, last: today }),
      );
      await writeRaw(
        failurePath,
        serializeMetadataFrontmatter({ id: FAIL_D, text: bodyD, created: today, last: today, state: "active" }),
      );

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      const manifest = store.getAssemblyManifest();

      // #05 { block, mdIds } UNCHANGED (additive signatures field).
      assert.equal(manifest.block, store.formatForSystemPrompt());
      assert.deepEqual(new Set(manifest.mdIds), new Set([MEM_A, MEM_B, USR_C, FAIL_D]));

      // One signature per surfaced md_id, each == computeSignature(body, default 24).
      const sigs = new Map(manifest.signatures.map((s) => [s.mdId, s.signature]));
      assert.deepEqual(new Set(sigs.keys()), new Set([MEM_A, MEM_B, USR_C, FAIL_D]));
      assert.equal(sigs.get(MEM_A), computeSignature(bodyA, 24));
      assert.equal(sigs.get(MEM_B), computeSignature(bodyB, 24));
      assert.equal(sigs.get(USR_C), computeSignature(bodyC, 24));
      assert.equal(sigs.get(FAIL_D), computeSignature(bodyD, 24));
    });

    it("getAssemblyManifest: under-min entries are omitted from signatures but stay in mdIds", async () => {
      const today = dateDaysAgo(0);
      const LONG = "55555555-eeee-5555-5555-555555555555";
      const SHORT = "66666666-ffff-6666-6666-666666666666";
      const longBody = `${TEST_MARKER} this one is long enough to qualify for a signature`;
      // Normalized fragment is well under the 24-char default → no signature.
      const shortBody = `${TEST_MARKER} tiny.`;
      await writeRaw(
        memoryPath,
        [
          serializeMetadataFrontmatter({ id: LONG, text: longBody, created: today, last: today }),
          serializeMetadataFrontmatter({ id: SHORT, text: shortBody, created: today, last: today }),
        ].join(ENTRY_DELIMITER),
      );

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      const manifest = store.getAssemblyManifest();

      // Both entries are still surfaced (#05 mdIds unchanged).
      assert.deepEqual(new Set(manifest.mdIds), new Set([LONG, SHORT]));
      // Only the long entry emits a signature; the short one is omitted entirely.
      const sigIds = manifest.signatures.map((s) => s.mdId);
      assert.ok(sigIds.includes(LONG));
      assert.ok(!sigIds.includes(SHORT));
      // The omitted entry never produces a signature object.
      assert.equal(manifest.signatures.find((s) => s.mdId === SHORT), undefined);
    });

    it("getAssemblyManifest: usedSignatureMinChars config is honored (lower threshold -> more signatures)", async () => {
      const today = dateDaysAgo(0);
      const BORDER = "77777777-0000-7777-7777-777777777777";
      // Normalized fragment ~17 chars: under the default 24, over 10.
      const borderBody = `${TEST_MARKER} mid.`;
      await writeRaw(
        memoryPath,
        serializeMetadataFrontmatter({ id: BORDER, text: borderBody, created: today, last: today }),
      );

      // Default (24): too short → omitted, but still surfaced in mdIds.
      const storeDefault = new MemoryStore(makeConfig());
      await storeDefault.loadFromDisk();
      const manifestDefault = storeDefault.getAssemblyManifest();
      assert.deepEqual(new Set(manifestDefault.mdIds), new Set([BORDER]));
      assert.equal(manifestDefault.signatures.length, 0);

      // Lower threshold (10): qualifies → emitted, equals computeSignature(body, 10).
      const storeLow = new MemoryStore(makeConfig({ usedSignatureMinChars: 10 }));
      await storeLow.loadFromDisk();
      const manifestLow = storeLow.getAssemblyManifest();
      assert.deepEqual(new Set(manifestLow.mdIds), new Set([BORDER]));
      assert.equal(manifestLow.signatures.length, 1);
      assert.equal(manifestLow.signatures[0].mdId, BORDER);
      assert.equal(manifestLow.signatures[0].signature, computeSignature(borderBody, 10));
    });

    it("getProjectAssemblyManifest: emits signatures for project memory ids", async () => {
      const today = dateDaysAgo(0);
      const PROJ_A = "88888888-1111-8888-8888-888888888888";
      const PROJ_B = "99999999-2222-9999-9999-999999999999";
      const bodyA = `${TEST_MARKER} project body A is long enough to qualify`;
      const bodyB = `${TEST_MARKER} project body B is also long enough to qualify`;
      await writeRaw(
        memoryPath,
        [
          serializeMetadataFrontmatter({ id: PROJ_A, text: bodyA, created: today, last: today }),
          serializeMetadataFrontmatter({ id: PROJ_B, text: bodyB, created: today, last: today }),
        ].join(ENTRY_DELIMITER),
      );

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      const name = "demo";
      const manifest = store.getProjectAssemblyManifest(name);

      // #05 { block, mdIds } UNCHANGED.
      assert.equal(manifest.block, store.formatProjectBlock(name));
      assert.deepEqual(new Set(manifest.mdIds), new Set([PROJ_A, PROJ_B]));

      const sigs = new Map(manifest.signatures.map((s) => [s.mdId, s.signature]));
      assert.deepEqual(new Set(sigs.keys()), new Set([PROJ_A, PROJ_B]));
      assert.equal(sigs.get(PROJ_A), computeSignature(bodyA, 24));
      assert.equal(sigs.get(PROJ_B), computeSignature(bodyB, 24));
    });
  });

  // ─── maybeProactiveConsolidate (proactive-consolidation Task 3) ───
  // The trigger method: when decay-pressure (below-heat-floor count) >= the
  // configured threshold AND the cooldown has elapsed, it fires a bounded pass
  // over the bottom-K below-floor entries via the Task 2 `candidates` seam.
  // DB-free by contract — it uses ONLY the injected heat provider + consolidator
  // + instance cooldown state; the CALLER (Task 4 write hook) checks in-flight
  // FIRST. makeStoreWithHeat factors the heat-wired-store pattern shared with
  // the #1b "heat-ordered eviction floors" + "consolidator snapshot heat-sort"
  // tests (frontmatter seed + setHeatForEntriesProvider keyed by mdId) so each
  // case only spells out the entry set + heat values + config.
  describe("maybeProactiveConsolidate (proactive-consolidation Task 3)", () => {
    const TODAY = new Date().toISOString().split("T")[0];

    /**
     * Build a heat-wired MemoryStore seeded with the given (text, heat) entries
     * into MEMORY.md, factored from the #1b heat tests. Each entry gets a
     * stable mdId; the provider returns Map<mdId, heat>. `configOverride` is
     * merged into the base test config (proactive defaults are OFF in makeConfig
     * — set them explicitly to exercise the trigger).
     */
    async function makeStoreWithHeat(
      entriesWithHeat: { text: string; heat: number }[],
      configOverride?: Partial<MemoryConfig>,
    ): Promise<MemoryStore> {
      const withIds = entriesWithHeat.map((e) => ({ id: globalThis.crypto.randomUUID(), ...e }));
      const encoded = withIds.map((e) =>
        serializeMetadataFrontmatter({ id: e.id, text: e.text, created: TODAY, last: TODAY }),
      );
      await fs.writeFile(path.join(MEMORY_DIR, MEMORY_FILE), encoded.join(ENTRY_DELIMITER), "utf-8");
      const store = new MemoryStore(makeConfig(configOverride));
      store.setHeatForEntriesProvider(async (_t, inputs) => {
        const m = new Map<string, number>();
        for (const input of inputs) {
          const entry = withIds.find((w) => w.id === input.mdId);
          if (entry) m.set(entry.id, entry.heat);
        }
        return m;
      });
      await store.loadFromDisk();
      return store;
    }

    it("is a no-op when disabled", async () => {
      const store = await makeStoreWithHeat(
        Array.from({ length: 12 }, (_, i) => ({ text: `cold${i}`, heat: 0.05 })),
        { proactiveConsolidateEnabled: false, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 },
      );
      let called = 0;
      store.setConsolidator(async (snapshot) => { called++; return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }; }, "test");
      assert.equal(await store.maybeProactiveConsolidate("memory"), null);
      assert.equal(called, 0);
    });

    it("fires when decay-pressure >= threshold, over the bottom-K below-floor entries", async () => {
      const store = await makeStoreWithHeat(
        [
          { text: "hot1", heat: 0.9 }, { text: "hot2", heat: 0.8 },
          ...Array.from({ length: 12 }, (_, i) => ({ text: `cold${i}`, heat: 0.05 })), // 12 below floor 0.25
        ],
        { proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 },
      );
      let seen: string[] = [];
      store.setConsolidator(async (snapshot) => { seen = snapshot.entries.map((e) => e.content); return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }; }, "test");
      const r = await store.maybeProactiveConsolidate("memory");
      assert.notEqual(r, null);
      assert.equal(seen.length, 5, `K cap; got ${seen.length}`); // K cap
      assert.ok(seen.every((s) => s.startsWith("cold")), `only below-floor cold entries; got ${JSON.stringify(seen)}`); // only below-floor
    });

    it("does NOT fire when below-floor count < threshold", async () => {
      const store = await makeStoreWithHeat(
        [
          { text: "hot", heat: 0.9 }, { text: "c1", heat: 0.05 }, { text: "c2", heat: 0.05 },
        ],
        { proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 },
      );
      let called = 0;
      store.setConsolidator(async (snapshot) => { called++; return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }; }, "test");
      assert.equal(await store.maybeProactiveConsolidate("memory"), null); // only 2 below floor < 10
      assert.equal(called, 0);
    });

    it("cooldown suppresses a second immediate pass", async () => {
      const store = await makeStoreWithHeat(
        Array.from({ length: 12 }, (_, i) => ({ text: `cold${i}`, heat: 0.05 })),
        { proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 },
      );
      let called = 0;
      store.setConsolidator(async (snapshot) => { called++; return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }; }, "test");
      await store.maybeProactiveConsolidate("memory"); // fires
      assert.equal(await store.maybeProactiveConsolidate("memory"), null); // cooldown
      assert.equal(called, 1);
    });
  });
});

describe("numeric isolation — assembled prompt never leaks memworth (UPSP §7 / DO ticket 04)", () => {
  let dir: string;
  let mp: string;
  let fp: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-iso-test-"));
    mp = path.join(dir, MEMORY_FILE);
    fp = path.join(dir, "failures.md");
  });
  afterAll(async () => {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(async () => {
    await removeFile(mp);
    await removeFile(fp);
  });

  it("formatProjectBlock strips the frontmatter (incl. memworth) — body only", async () => {
    // A frontmatter entry carrying memworth (success=5, fail=3). Before the
    // fix this leaked the WHOLE YAML block (id/created/.../memworth) into the
    // project prompt; the sibling render paths already stripped. Now stripped.
    const entry = serializeMetadataFrontmatter({
      id: "iso-proj-1",
      text: "numeric-iso project convention body",
      created: "2026-08-02",
      last: "2026-08-02",
      mwSuccess: 5,
      mwFail: 3,
    });
    await writeRaw(mp, entry);

    const store = new MemoryStore(makeConfig({ memoryDir: dir }));
    await store.loadFromDisk();

    const block = store.formatProjectBlock("demo");
    assert.ok(block, "project block should render");
    assert.match(block, /numeric-iso project convention body/);
    assert.doesNotMatch(block, /memworth/);
    assert.doesNotMatch(block, /success:\s*5/);
    assert.doesNotMatch(block, /fail:\s*3/);
    assert.doesNotMatch(block, /iso-proj-1/);
  });

  it("formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)", async () => {
    // Both the memory block (snapshot, stripped) and the failure block
    // (getActiveFailureEntries, stripped) must stay isolated. Pins the existing
    // behavior so a future change can't start surfacing raw counters.
    //
    // Failure entries are age-gated by DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS
    // (7). A fixed past created-date ages out of the injection window and the
    // fixture stops being injected, red-ing this regression pin over time. Use
    // a created-date relative to NOW (now - 1d) so the fixture is permanently
    // in-window at test time — never ages out again.
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const mem = serializeMetadataFrontmatter({
      id: "iso-mem-1", text: "numeric-iso global memory body",
      created: recentIso, last: recentIso, mwFail: 7,
    });
    const fail = serializeMetadataFrontmatter({
      id: "iso-fail-1", text: "[failure] numeric-iso lesson — Failed: x",
      created: recentIso, last: recentIso, state: "active", mwSuccess: 2,
    });
    await writeRaw(mp, mem);
    await writeRaw(fp, fail);

    const store = new MemoryStore(makeConfig({ memoryDir: dir }));
    await store.loadFromDisk();

    const prompt = store.formatForSystemPrompt();
    assert.match(prompt, /numeric-iso global memory body/);
    assert.match(prompt, /numeric-iso lesson/);
    assert.doesNotMatch(prompt, /memworth/);
    assert.doesNotMatch(prompt, /fail:\s*7/);
    assert.doesNotMatch(prompt, /success:\s*2/);
  });
});
