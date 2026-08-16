import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSeam, type KnowledgePipeline } from "@repo/pi-agent-core-interface";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { createCardStore } from "../src/store/card-store.js";

const KEY = "__piKnowledgePipeline";
const FOLDER = "Zettelkasten/knowledge-graph";

/** A zk-shaped stub that writes vault-md (mimicking zk's ingestRecords) and
 *  returns a non-empty HealReceipt (mimicking zk's healGraph). This exercises
 *  the orchestration contract without coupling hermes to zk at test time. */
function makeStubPipeline(): KnowledgePipeline {
  return {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (records, opts) => {
      const dir = join(opts.vaultPath, opts.folder);
      mkdirSync(dir, { recursive: true });
      let created = 0;
      const cards = records.map((r) => {
        const slug = r.id.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
        const fp = join(dir, `${slug}.md`);
        const existed = existsSync(fp);
        // Idempotent at the file level (models zk's no-op for unchanged records):
        // only EMIT vault-md when the card is new, so an external edit to an
        // existing card PERSISTS across re-ingest (the Tier-1 drift hash must
        // detect it). Existing files keep their bytes untouched here.
        if (!existed) {
          const recordTags = Array.isArray(r.tags) ? r.tags.filter((t) => t !== "zettel") : [];
          const fmTags = ["zettel", ...recordTags];
          const body = [
            "---",
            `id: ${r.id}`,
            "created: 2026-01-01",
            `tags: [${fmTags.join(", ")}]`,
            "---",
            `# ${r.title}`,
            "",
            "## 核心想法",
            r.detail || r.title,
            "",
          ].join("\n");
          writeFileSync(fp, body + "\n");
          created++;
        }
        return { id: r.id, path: `${opts.folder}/${slug}.md`, status: existed ? "unchanged" : "created", links: 0 };
      });
      return {
        source: opts.source, sourceLabel: opts.sourceLabel, total: records.length,
        created, updated: 0, unchanged: records.length - created, skipped: 0, linked: 0, wikiMerged: 0,
        mocUpdated: false, vaultPath: opts.vaultPath, folder: opts.folder, cards, parseErrors: [],
      };
    },
    runConvergenceLoop: async () => ({
      sourcesIngested: 0, created: 0, updated: 0, unchanged: 0, deadLinksBefore: 0, deadLinksAfter: 0,
      mocMissingBefore: false, mocMissingAfter: false, rounds: 0, converged: false, truncated: false, health: null,
    }),
    retrieveRecords: async () => ({ count: 0, cards: [], digest: "", folder: "", scanned: 0, excluded: 0 }),
    healGraph: async () => ({ mocRegenerated: true, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] }),
  };
}

describe("walkAndIngest (orchestrator: walk → adapt → ingest → heal)", () => {
  let vault: string;
  let inputDir: string;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    vault = mkdtempSync(join(tmpdir(), "kvi-vault-"));
    inputDir = mkdtempSync(join(tmpdir(), "kvi-input-"));
    process.env.KNOWLEDGE_VAULT_PATH = vault;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    rmSync(vault, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  });

  it("walks → parses → ingests (vault-md written) → heals once", async () => {
    const jsonl = [
      '{"id":"r1","type":"lever","title":"Rec One","detail":"","tags":["a"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r2","type":"gotcha","title":"Rec Two","detail":"","tags":["b"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r3","type":"pattern","title":"Rec Three","detail":"","tags":["c"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
    ].join("\n");
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), jsonl);
    // junk to skip (must not reach ingest)
    mkdirSync(join(inputDir, ".git"), { recursive: true });
    writeFileSync(join(inputDir, ".git", "config"), "junk");
    writeFileSync(join(inputDir, "blob.zip"), "PK");

    publishSeam(KEY, makeStubPipeline());
    // Explicit tmpdir memoryDir (F2): never default to the REAL
    // ~/.pi/agent/pi-hermes-memory DB from a test (sandbox read-only / live-
    // session clobbering). Sibling tests follow the same pattern.
    const memDir = mkdtempSync(join(tmpdir(), "kvi-mem-"));
    try {
      const receipt = await walkAndIngest(inputDir, { memoryDir: memDir });

      assert.equal(receipt.ok, true);
      assert.equal(receipt.seamPresent, true);
      assert.equal(receipt.vaultPath, vault);
      assert.equal(receipt.folder, FOLDER);
      assert.ok(receipt.ingest, "ingest summary present");
      assert.ok((receipt.ingest!.created + receipt.ingest!.updated) >= 3, "≥3 records ingested");
      assert.ok(receipt.heal, "heal receipt present");
      assert.equal(receipt.heal!.mocRegenerated, true, "MOC regenerated");
      // vault-md written under <vault>/<folder>/
      const dir = join(vault, FOLDER);
      assert.ok(existsSync(dir), "convergence folder created");
      const mds = readdirSync(dir).filter((n) => n.endsWith(".md"));
      assert.ok(mds.length >= 3, `≥3 vault-md files written (got ${mds.length})`);
      // junk skipped
      assert.ok(receipt.skipped.dirs.some((d) => d.endsWith(".git")), ".git skipped");
      assert.ok(receipt.skipped.binaries.some((b) => b.endsWith("blob.zip")), "blob.zip skipped");
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully when the zk seam is absent", async () => {
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), '{"id":"r1","title":"R"}');
    // Explicit tmpdir memoryDir (F2): the memory DB-mirror (step 8d) opens the
    // store unconditionally — never point it at the real ~/.pi/agent DB.
    const memDir = mkdtempSync(join(tmpdir(), "kvi-mem-"));
    try {
      const receipt = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(receipt.ok, false);
      assert.equal(receipt.seamPresent, false);
      assert.match(receipt.reason ?? "", /seam not present/i);
      assert.equal(receipt.mirrored, 0);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("DB-mirrors vault-md into the unified card-store (idempotent, single dedup site)", async () => {
    const jsonl = [
      '{"id":"r1","type":"lever","title":"Rec One","detail":"d1","tags":["a"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r2","type":"gotcha","title":"Rec Two","detail":"d2","tags":["b"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r3","type":"pattern","title":"Rec Three","detail":"d3","tags":["c"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
    ].join("\n");
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), jsonl);
    publishSeam(KEY, makeStubPipeline());
    // Reuse the SAME SQLite DB the memory-cards use (06a unified store). The
    // mirror opens createCardStore({memoryDir}) against a temp memory dir here;
    // in production this resolves to the existing hermes memory DB dir (NOT the
    // obsidian vault — no <vault>/.knowledge-db).
    const memDir = mkdtempSync(join(tmpdir(), "kvi-mem-"));
    try {
      const r1 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r1.ok, true);
      assert.ok(r1.mirrored >= 3, `mirrored ≥3 vault-md cards (got ${r1.mirrored})`);

      // The DB mirror holds the cards — ids match the vault-md knowledge-cards.
      const store1 = await createCardStore({ memoryDir: memDir });
      try {
        const cards = await store1.getCardsByKind("knowledge");
        assert.ok(cards.length >= 3, `≥3 knowledge rows in the unified store (got ${cards.length})`);
        const ids = new Set(cards.map((c) => c.id));
        assert.ok(ids.has("r1") && ids.has("r2") && ids.has("r3"), "ids r1/r2/r3 mirrored");
        for (const c of cards) assert.equal(c.kind, "knowledge");
      } finally {
        await store1.close();
      }

      // Re-running walkAndIngest on the same input is IDEMPOTENT: the vault-md
      // corpus is unchanged → KnowledgeDedupStrategy (id-upsert) yields ZERO new
      // rows. mirrored is stable; the row count does not double.
      const r2 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r2.mirrored, r1.mirrored, "mirrored stable on re-run");
      const store2 = await createCardStore({ memoryDir: memDir });
      try {
        const cards2 = await store2.getCardsByKind("knowledge");
        assert.equal(cards2.length, 3, "exactly 3 rows after re-run (no duplicates)");
      } finally {
        await store2.close();
      }
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("Tier-1 drift stub: stable sha256 across runs; detects a changed vault-md card", async () => {
    const jsonl = [
      '{"id":"d1","type":"lever","title":"Drift One","detail":"base","tags":["d"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
    ].join("\n");
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), jsonl);
    publishSeam(KEY, makeStubPipeline());
    const memDir = mkdtempSync(join(tmpdir(), "kvi-drift-"));
    try {
      // Run 1: capture the md-hash set.
      const r1 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r1.ok, true);
      assert.ok(r1.driftStub.filesHashed >= 1, `filesHashed ≥1 (got ${r1.driftStub.filesHashed})`);
      const h1 = r1.driftStub.currentHashes;
      assert.ok(h1 && Object.keys(h1).length >= 1, "currentHashes populated");
      const firstHash = Object.values(h1)[0]!;
      assert.match(firstHash, /^[0-9a-f]{64}$/, "hash is sha256 (64 hex chars)");

      // Run 2 on the SAME input (unchanged vault-md) → identical hashes (stable).
      const r2 = await walkAndIngest(inputDir, { memoryDir: memDir, previousHashes: h1 });
      assert.deepEqual(r2.driftStub.currentHashes, h1, "hashes stable across runs (unchanged corpus)");
      assert.deepEqual(r2.driftStub.previousHashes, h1, "previousHashes echoed for change-detection");

      // Mutate one vault-md card (simulating an external edit) → its hash changes.
      const dir = join(vault, FOLDER);
      const mds = readdirSync(dir).filter((n) => n.endsWith(".md"));
      assert.ok(mds.length >= 1, "≥1 vault-md file to mutate");
      const target = join(dir, mds[0]!);
      writeFileSync(target, readFileSync(target, "utf8") + "\n## mutated externally\n");
      const r3 = await walkAndIngest(inputDir, { memoryDir: memDir, previousHashes: h1 });
      const relKey = Object.keys(h1).find((k) => k.endsWith(mds[0]!));
      assert.ok(relKey, "relPath key found in currentHashes");
      assert.notEqual(
        r3.driftStub.currentHashes[relKey],
        h1[relKey],
        "mutated card hash changed (drift detected)",
      );
      assert.deepEqual(r3.driftStub.previousHashes, h1, "previousHashes still echoed on run 3");
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("Tier-1 drift receipt arms: changed (INSERT) → unchanged (skip) → changed (UPDATE) → removed (sweep)", async () => {
    // Same zk-shaped stub + fixture family as the hash-stability test above:
    // the stub only EMITS vault-md for new files, so an external edit/delete
    // persists across runs — exactly what the drift arms must classify.
    const jsonl =
      '{"id":"d1","type":"lever","title":"Drift One","detail":"base","tags":["d"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}';
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), jsonl);
    publishSeam(KEY, makeStubPipeline());
    const memDir = mkdtempSync(join(tmpdir(), "kvi-drift-"));
    try {
      // (a) First run on an empty store: the only vault-md card is new → the
      // INSERT arm counts it as changed; nothing to skip, nothing to sweep.
      const r1 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r1.ok, true);
      assert.equal(r1.driftStub.changed, 1, "(a) first run: new card → changed=INSERT");
      assert.equal(r1.driftStub.unchanged, 0, "(a) first run: nothing to skip yet");
      assert.equal(r1.driftStub.removed, 0, "(a) first run: nothing to sweep");
      assert.equal("driftDisabled" in r1.driftStub, false, "sqlite store: drift arms enabled");

      // (b) Identical re-run: the stub leaves the existing md bytes untouched
      // → hash-match skip arm only (cheap idempotent re-walk).
      const r2 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r2.ok, true);
      assert.equal(r2.driftStub.changed, 0, "(b) unchanged corpus: zero changed");
      assert.equal(r2.driftStub.unchanged, 1, "(b) unchanged corpus: hash-match skip");
      assert.equal(r2.driftStub.removed, 0, "(b) unchanged corpus: zero removed");

      // (c) External edit to the `## 核心想法` section body (the part that
      // drives the card content hash) → the UPDATE arm fires for exactly the
      // mutated card.
      const dir = join(vault, FOLDER);
      const mds = readdirSync(dir).filter((n) => n.endsWith(".md"));
      assert.equal(mds.length, 1, "exactly one vault-md fixture file");
      const target = join(dir, mds[0]!);
      const before = readFileSync(target, "utf8");
      assert.ok(before.includes("## 核心想法\nbase\n"), "fixture carries the 核心想法 body");
      writeFileSync(target, before.replace("## 核心想法\nbase\n", "## 核心想法\nkp21 tier-1 externally edited\n"));
      const r3 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r3.driftStub.changed, 1, "(c) edited card: exactly the mutated one changed");
      assert.equal(r3.driftStub.unchanged, 0, "(c) edited card: no skips");
      assert.equal(r3.driftStub.removed, 0, "(c) edited card: no removals");

      // (d) md-wins sweep: the mirror always walks the FULL folder
      // (readdirSync of <vault>/<folder>), and the sweep runs on every
      // drift-capable pass. The deletion only sticks because the record ALSO
      // leaves the input — the stub re-creates missing md for records still
      // present in the jsonl. Swap the input to a different id, so the walked
      // present-set no longer holds d1 → its card + hash row are swept.
      unlinkSync(target);
      writeFileSync(
        join(inputDir, "run.knowledge.jsonl"),
        '{"id":"d2","type":"lever","title":"Drift Two","detail":"second","tags":["d"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      );
      const r4 = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(r4.ok, true);
      assert.equal(r4.driftStub.removed, 1, "(d) deleted md swept out of the store");
      assert.equal(r4.driftStub.changed, 1, "(d) the replacement record is the only change");
      // The sweep is real: d1's card is hard-deleted from the unified store.
      const store = await createCardStore({ memoryDir: memDir });
      try {
        assert.equal(await store.getCard("d1"), null, "(d) d1 card hard-deleted by the sweep");
        assert.notEqual(await store.getCard("d2"), null, "(d) d2 card present after the sweep");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  describe("kp21 Tier-3: db-authoritative frontmatter merge (opt-in DB-wins fields)", () => {
    // One-record fixture (same zk-shaped stub + fixture family as the Tier-1
    // drift tests above). The stub's vault-md frontmatter carries id/created/
    // tags but NO used_at — tests (a)-(c) splice `used_at: T1` into the md
    // externally after the first plain walk; test (d) relies on the field
    // staying absent, exactly as the stub writes it.
    const writeTier3Fixture = () => {
      writeFileSync(
        join(inputDir, "run.knowledge.jsonl"),
        '{"id":"u1","type":"lever","title":"Tier Three","detail":"t3","tags":["u"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      );
      publishSeam(KEY, makeStubPipeline());
    };

    const mdPathOf = () => {
      const dir = join(vault, FOLDER);
      const mds = readdirSync(dir).filter((n) => n.endsWith(".md"));
      assert.equal(mds.length, 1, "exactly one vault-md fixture file");
      return join(dir, mds[0]!);
    };

    /** External md edit: insert a top-level `used_at:` line as the first
     *  frontmatter key (the stub never writes this field itself). */
    const spliceUsedAtIntoMd = (fp: string, value: string) => {
      const before = readFileSync(fp, "utf8");
      assert.ok(before.startsWith("---\n"), "fixture md opens with frontmatter");
      writeFileSync(fp, before.replace(/^---\n/, `---\nused_at: ${value}\n`));
    };

    /** Seed DB divergence the way production state looks: open the SAME store
     *  the mirror opens (createCardStore({memoryDir})), clone the mirrored
     *  card, set the field on the DB row (updateCard — adds the key when
     *  absent), verify the write round-tripped, close. Stored card_md_hash
     *  rows are left untouched. */
    const seedDbUsedAt = async (memDir: string, value: string) => {
      const store = await createCardStore({ memoryDir: memDir });
      try {
        const card = (await store.getCardsByKind("knowledge")).find((c) => c.id === "u1");
        assert.ok(card, "u1 knowledge card mirrored before seeding");
        await store.updateCard({
          id: card.id,
          kind: card.kind,
          content: card.content,
          frontmatter: { ...(card.frontmatter ?? {}), used_at: value },
        });
        // Prove the divergence actually persisted (DB row must hold `value`).
        const verify = await store.getCard("u1");
        assert.equal(
          verify?.frontmatter?.used_at,
          value,
          `seed round-tripped: DB row used_at=${value}`,
        );
      } finally {
        await store.close();
      }
    };

    it("Tier-3: DB-authoritative field wins over md when opted in (no write-back)", async () => {
      writeTier3Fixture();
      const memDir = mkdtempSync(join(tmpdir(), "kvi-t3a-"));
      try {
        // Plain first walk: stub emits the vault-md (no used_at) and the
        // mirror stores the card + its md hash.
        const r1 = await walkAndIngest(inputDir, { memoryDir: memDir });
        assert.equal(r1.ok, true);
        const fp = mdPathOf();
        // md now says T1; the DB row is seeded to a divergent T2.
        spliceUsedAtIntoMd(fp, "T1");
        await seedDbUsedAt(memDir, "T2");

        const r2 = await walkAndIngest(inputDir, {
          memoryDir: memDir,
          dbAuthoritativeFields: ["used_at"],
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.dbAuthoritative.merged, 1, "one opted-in value copied DB→card");
        assert.equal(r2.dbAuthoritative.writtenBack, 0, "write-back off by default");

        // No write-through: the md file on disk still carries T1.
        const mdText = readFileSync(fp, "utf8");
        assert.ok(mdText.includes("used_at: T1"), "md file on disk still carries T1");
        assert.ok(!mdText.includes("used_at: T2"), "no md write-through without the opt-in");

        // The DB row keeps the DB-authoritative value into the next mirror.
        const store = await createCardStore({ memoryDir: memDir });
        try {
          const card = await store.getCard("u1");
          assert.equal(card?.frontmatter?.used_at, "T2", "merged card keeps the DB value");
        } finally {
          await store.close();
        }

        // Without write-back the md file keeps its stale T1 forever
        // (decision 05: no md write-through), so md↔DB divergence persists
        // and EVERY opted-in run re-merges the DB value into the card
        // (merged stays 1 — an idempotent re-merge, not a new change).
        // The true convergence signal is store/hash stability: run 3 hits
        // the skip arm (driftStub.changed === 0) and the stored card keeps
        // the DB-authoritative value.
        const r3 = await walkAndIngest(inputDir, {
          memoryDir: memDir,
          dbAuthoritativeFields: ["used_at"],
        });
        assert.equal(
          r3.dbAuthoritative.merged,
          1,
          "divergence persists without write-back: idempotent re-merge every run",
        );
        assert.equal(r3.driftStub.changed, 0, "converged: skip arm — store/hash stable");
        const store3 = await createCardStore({ memoryDir: memDir });
        try {
          const card3 = await store3.getCard("u1");
          assert.equal(
            card3?.frontmatter?.used_at,
            "T2",
            "store card still holds the DB value after run 3",
          );
        } finally {
          await store3.close();
        }
      } finally {
        rmSync(memDir, { recursive: true, force: true });
      }
    });

    it("Tier-3: opt-in write-back syncs md file from DB", async () => {
      writeTier3Fixture();
      const memDir = mkdtempSync(join(tmpdir(), "kvi-t3b-"));
      try {
        await walkAndIngest(inputDir, { memoryDir: memDir }); // md + mirror + hash
        const fp = mdPathOf();
        spliceUsedAtIntoMd(fp, "T1");
        await seedDbUsedAt(memDir, "T2");

        const r2 = await walkAndIngest(inputDir, {
          memoryDir: memDir,
          dbAuthoritativeFields: ["used_at"],
          dbAuthoritativeWriteBack: true,
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.dbAuthoritative.merged, 1, "DB value merged into the mirrored card");
        assert.equal(r2.dbAuthoritative.writtenBack, 1, "exactly one md line written back");

        const mdText = readFileSync(fp, "utf8");
        assert.ok(mdText.includes("used_at: T2"), "md file now carries the DB value");
        assert.ok(!mdText.includes("used_at: T1"), "stale md line replaced in place");

        // Converged: md and DB agree now → nothing merged, nothing written.
        const r3 = await walkAndIngest(inputDir, {
          memoryDir: memDir,
          dbAuthoritativeFields: ["used_at"],
          dbAuthoritativeWriteBack: true,
        });
        assert.equal(r3.dbAuthoritative.merged, 0, "converged: no merge on re-run");
        assert.equal(r3.dbAuthoritative.writtenBack, 0, "converged: no write-back on re-run");
      } finally {
        rmSync(memDir, { recursive: true, force: true });
      }
    });

    it("Tier-3: default off preserves md-canonical behavior", async () => {
      writeTier3Fixture();
      const memDir = mkdtempSync(join(tmpdir(), "kvi-t3c-"));
      try {
        await walkAndIngest(inputDir, { memoryDir: memDir }); // md + mirror + hash
        const fp = mdPathOf();
        spliceUsedAtIntoMd(fp, "T1");
        await seedDbUsedAt(memDir, "T2");

        // NO tier-3 opts: md stays canonical — the re-walk overwrites the
        // seeded DB divergence with the md value.
        const r2 = await walkAndIngest(inputDir, { memoryDir: memDir });
        assert.equal(r2.ok, true);
        assert.deepEqual(
          r2.dbAuthoritative,
          { merged: 0, writtenBack: 0 },
          "receipt arms idle when the feature is off",
        );

        const store = await createCardStore({ memoryDir: memDir });
        try {
          const card = await store.getCard("u1");
          assert.equal(card?.frontmatter?.used_at, "T1", "md value wins into the DB row");
        } finally {
          await store.close();
        }
        assert.ok(readFileSync(fp, "utf8").includes("used_at: T1"), "md file untouched");
      } finally {
        rmSync(memDir, { recursive: true, force: true });
      }
    });

    it("Tier-3: field absent in md gains the line on write-back", async () => {
      writeTier3Fixture();
      const memDir = mkdtempSync(join(tmpdir(), "kvi-t3d-"));
      try {
        // The stub's md carries NO used_at line — keep it that way (the
        // absent-field arm of write-back).
        await walkAndIngest(inputDir, { memoryDir: memDir }); // md + mirror + hash
        const fp = mdPathOf();
        assert.ok(!readFileSync(fp, "utf8").includes("used_at"), "fixture md lacks used_at");
        await seedDbUsedAt(memDir, "T9"); // upsert ADDS the field to the DB row

        const r2 = await walkAndIngest(inputDir, {
          memoryDir: memDir,
          dbAuthoritativeFields: ["used_at"],
          dbAuthoritativeWriteBack: true,
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.dbAuthoritative.merged, 1, "absent in md + set in DB → merged");
        assert.equal(r2.dbAuthoritative.writtenBack, 1, "line inserted into the md file");

        const mdText = readFileSync(fp, "utf8");
        const fmBlock = mdText.split("---\n")[1] ?? "";
        assert.ok(fmBlock.includes("used_at: T9"), "used_at: T9 inserted inside the frontmatter");
      } finally {
        rmSync(memDir, { recursive: true, force: true });
      }
    });
  });

  it("reports generic family as detected-but-deferred (not ingested)", async () => {
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), '{"id":"r1","title":"R"}');
    mkdirSync(join(inputDir, "notes"), { recursive: true });
    writeFileSync(join(inputDir, "notes", "readme.md"), "# readme");
    publishSeam(KEY, makeStubPipeline());

    // Explicit tmpdir memoryDir (F2): the memory DB-mirror opens the store
    // unconditionally — never default to the real ~/.pi/agent DB.
    const memDir = mkdtempSync(join(tmpdir(), "kvi-mem-"));
    try {
      const receipt = await walkAndIngest(inputDir, { memoryDir: memDir });
      assert.equal(receipt.ok, true);
      // generic .md is NOT in the ingest count (only the 1 jsonl record ingested).
      assert.equal(receipt.ingest!.created, 1);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — planning family (seam-independent)", () => {
  it("mirrors .planning/ into the card-store without the zk seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-walk-"));
    const mem = mkdtempSync(join(tmpdir(), "planning-walk-mem-"));
    try {
      const effort = "fixture-walk-effort";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(
        join(root, ".planning", effort, "map.md"),
        "---\nstatus: active\n---\n# Walk effort\n\n## Destination\nd\n",
      );
      writeFileSync(
        join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nDone.\n",
      );
      // Absolute input -> rel paths retain the `.planning` segment the classifier needs.
      const receipt = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(receipt.planningMirrored >= 2, `expected >=2 mirrored, got ${receipt.planningMirrored}`);

      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      const efforts = await store.getCardsByKind("planning-effort");
      await store.close();
      assert.ok(tickets.some((c) => c.id === `planning-ticket:${effort}:01`));
      assert.ok(efforts.some((c) => c.id === `planning-effort:${effort}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — planning mirror drift (09-impl T3)", () => {
  it("INSERTs a new ticket (no stored hash)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-ins-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-ins-mem-"));
    try {
      const effort = "drift-ins";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.planningMirrored >= 1);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /First\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("UPDATEs an edited ticket (hash mismatch) instead of skipping", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-upd-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-upd-mem-"));
    try {
      const effort = "drift-upd";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nOriginal.\n");
      await walkAndIngest(root, { memoryDir: mem });            // mirror once (INSERT + hash)
      // Edit the ticket content (git-canonical md changed).
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED body.\n");
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror → UPDATE
      assert.ok(r2.planningMirrored >= 1, "edited ticket must be re-mirrored (UPDATE), not skipped");
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /EDITED body\./);
      assert.doesNotMatch(c?.content ?? "", /Original\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips an UNCHANGED ticket (hash match — no write)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-skip-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-skip-mem-"));
    try {
      const effort = "drift-skip";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const body = "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nStable.\n";
      writeFileSync(ticketPath, body);
      await walkAndIngest(root, { memoryDir: mem });             // mirror once
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror unchanged
      assert.equal(r2.planningMirrored, 0, "unchanged ticket must be skipped (hash match)");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — planning delete reconciliation (09-impl T4)", () => {
  it("hard-deletes planning rows whose source md vanished (md-wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "precon-"));
    const mem = mkdtempSync(join(tmpdir(), "precon-mem-"));
    try {
      const effort = "recon-del";
      const t01 = join(root, ".planning", effort, "tickets", "01-keep.md");
      const t02 = join(root, ".planning", effort, "tickets", "02-gone.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(t01, "---\ntype: task\nstatus: closed\n---\n# 01 — keep\n\n## Resolution\nKeep.\n");
      writeFileSync(t02, "---\ntype: task\nstatus: closed\n---\n# 02 — gone\n\n## Resolution\nGone.\n");
      await walkAndIngest(root, { memoryDir: mem });             // mirror both tickets
      // Source md for ticket 02 is removed (git rm / file deleted).
      unlinkSync(t02);
      await walkAndIngest(root, { memoryDir: mem });             // re-walk → sweep deletes 02
      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      await store.close();
      const ids = tickets.map((c) => c.id).sort();
      assert.deepEqual(ids, [`planning-ticket:${effort}:01`]);
      assert.ok(!ids.includes(`planning-ticket:${effort}:02`), "vanished ticket row must be hard-deleted");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — partial walk must NOT reconcile (09-impl final review A)", () => {
  it("a bounded/partial walk keeps out-of-window planning cards (no mass-delete)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwalk-A-"));
    const mem = mkdtempSync(join(tmpdir(), "pwalk-A-mem-"));
    try {
      const effort = "partial-eff";
      const t01 = join(root, ".planning", effort, "tickets", "01-a.md");
      const t02 = join(root, ".planning", effort, "tickets", "02-b.md");
      const t03 = join(root, ".planning", effort, "tickets", "03-c.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      for (const [p, n] of [[t01, "01 — a"], [t02, "02 — b"], [t03, "03 — c"]] as const) {
        writeFileSync(p, `---\ntype: task\nstatus: closed\n---\n# ${n}\n\n## Resolution\nbody.\n`);
      }
      // COMPLETE walk over the repo root → all three mirrored (hashes written).
      await walkAndIngest(root, { memoryDir: mem });

      // PARTIAL/bounded walk over a proper SUBSET (only t01) — exactly what the
      // T6 background backfill feeds reconcile (a bounded ≤MAX_FILES subset of
      // this repo's 948 .planning md). partialWalk:true MUST suppress delete-
      // reconciliation so the out-of-window cards (02, 03 — whose md still
      // exists on disk but is outside the subset) are NOT hard-deleted.
      await walkAndIngest([t01], { memoryDir: mem, planningOnly: true, partialWalk: true });

      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      await store.close();
      const ids = tickets.map((c) => c.id).sort();
      assert.deepEqual(
        ids,
        [
          `planning-ticket:${effort}:01`,
          `planning-ticket:${effort}:02`,
          `planning-ticket:${effort}:03`,
        ],
        "partial walk must NOT hard-delete out-of-window planning cards",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — 08→09 migration cohort unfreeze (09-impl final review B)", () => {
  it("UPDATEs an existing-but-unhashed planning card (drift), not insert-no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmig-B-"));
    const mem = mkdtempSync(join(tmpdir(), "pmig-B-mem-"));
    try {
      const effort = "mig-eff";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const id = `planning-ticket:${effort}:01`;
      // Pre-seed an 08-era row directly: OLD content, NO card_md_hash row
      // (stored===null — true for EVERY existing planning card on first 09
      // touch, since card_md_hash is brand-new empty). This is the migration
      // cohort the per-task T3 test cannot reach (it only hits UPDATE via
      // stored≠null+mismatch).
      const store0 = await createCardStore({ memoryDir: mem });
      await store0.upsertCard({
        id,
        kind: "planning-ticket",
        content: "OLD 08-era body.",
        frontmatter: { id: "01", slug: "x", status: "closed" },
      });
      await store0.close();

      // Source md has DRIFTED to new (current) content relative to the DB row.
      writeFileSync(
        ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nNEW 09-era body.\n",
      );
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.planningMirrored >= 1, "migration-cohort card must be re-mirrored (UPDATE), not skipped");

      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(id);
      const hash = await store.getCardMdHash(id);
      await store.close();
      assert.match(c?.content ?? "", /NEW 09-era body\./, "DB row updated to current md");
      assert.doesNotMatch(c?.content ?? "", /OLD 08-era body\./, "08-era content must be overwritten");
      assert.ok(hash, "hash seeded on first 09 touch");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("walkAndIngest — conflict-marker flag (09-impl T5)", () => {
  it("surfaces an effort with unresolved merge markers in its ticket md; clean md not flagged; mirror still runs (non-blocking)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pconf-"));
    const mem = mkdtempSync(join(tmpdir(), "pconf-mem-"));
    try {
      const effort = "conflict-effort";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.conflictMarkerEfforts.includes(effort), "effort must be flagged for human review");
      // The mirror STILL runs — conflict markers do NOT block the mirror (advisory flag).
      assert.ok(r.planningMirrored >= 1, "mirror must still run on a conflicted file (non-blocking)");
      // And the conflicted ticket DID land in the DB (non-blocking proof).
      const store = await createCardStore({ memoryDir: mem });
      const mirrored = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(mirrored?.content ?? "", /ours/, "conflicted ticket body mirrored around the markers");

      // Clean the markers and re-mirror → the effort is NOT re-flagged.
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nClean now.\n");
      const r2 = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(!r2.conflictMarkerEfforts.includes(effort), "clean md must not be flagged");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
