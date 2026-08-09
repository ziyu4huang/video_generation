import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSeam, type KnowledgePipeline } from "@repo/pi-agent-ext-core-interface";
import { walkAndIngest } from "../src/walk-and-ingest.js";

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
      const cards = records.map((r) => {
        const slug = r.id.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
        writeFileSync(join(dir, `${slug}.md`), `---\nid: ${r.id}\ntitle: ${r.title}\n---\n# ${r.title}\n`);
        return { id: r.id, path: `${opts.folder}/${slug}.md`, status: "created", links: 0 };
      });
      return {
        source: opts.source, sourceLabel: opts.sourceLabel, total: records.length,
        created: records.length, updated: 0, unchanged: 0, skipped: 0, linked: 0, wikiMerged: 0,
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

    const receipt = await walkAndIngest(inputDir);

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
  });

  it("degrades gracefully when the zk seam is absent", async () => {
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), '{"id":"r1","title":"R"}');
    const receipt = await walkAndIngest(inputDir);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.seamPresent, false);
    assert.match(receipt.reason ?? "", /seam not present/i);
    assert.equal(receipt.mirrored, 0);
  });

  it("reports generic family as detected-but-deferred (not ingested)", async () => {
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), '{"id":"r1","title":"R"}');
    mkdirSync(join(inputDir, "notes"), { recursive: true });
    writeFileSync(join(inputDir, "notes", "readme.md"), "# readme");
    publishSeam(KEY, makeStubPipeline());

    const receipt = await walkAndIngest(inputDir);
    assert.equal(receipt.ok, true);
    // generic .md is NOT in the ingest count (only the 1 jsonl record ingested).
    assert.equal(receipt.ingest!.created, 1);
  });
});
