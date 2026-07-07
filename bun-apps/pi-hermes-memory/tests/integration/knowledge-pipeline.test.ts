/**
 * End-to-end golden test for the smart-knowledge-pipeline.
 *
 * Wires every stage against a real temp vault (no mocks):
 *   [1] TRIGGER      — a lesson-worthy error produces a failure entry
 *                      (what setupErrorDetector writes; here we call addFailure
 *                      directly to simulate the captured lesson).
 *   [2] TRANSFER     — convergeToVault moves the entry → atomic zettel card in
 *                      the default vault, in ONE step (no manual zk_ingest).
 *   [3] DISTILL/MERGE — retrieveRecords surfaces the card (retrieval works);
 *                      mergeDuplicates finds no spurious dupes; graphHealth is
 *                      clean (0 dead links, MOC present).
 *
 * This is the receipt the goal's §6 Definition-of-Done asks for, as a test.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convergeToVault } from "../../src/store/vault-converge.js";
import {
  retrieveRecords,
  graphHealth,
  healGraph,
} from "pi-knowledge-card/src/retrieve.ts";
import { mergeDuplicates as mergeDuplicatesFromMerge } from "pi-knowledge-card/src/merge.ts";

let vault: string;
let prevVaultPath: string | undefined;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-e2e-"));
  prevVaultPath = process.env.OB_VAULT_PATH;
  process.env.OB_VAULT_PATH = vault;
});
afterEach(() => {
  if (prevVaultPath === undefined) delete process.env.OB_VAULT_PATH;
  else process.env.OB_VAULT_PATH = prevVaultPath;
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("smart-knowledge-pipeline — end-to-end golden flow", () => {
  it("captured error → vault card → retrieval → no dupes → clean graph", async () => {
    // ── [1] TRIGGER: a lesson-worthy error was captured (failure entry) ──
    const failureEntry =
      "[bash error] Error: ENOENT: no such file or directory, open 'python/venv/bin/python' — the mlx venv must be recreated with uv after a fresh clone.";

    // ── [2] TRANSFER + STORE: one hop into the default vault ──
    const converge = await convergeToVault([failureEntry], "failure", vault);
    assert.equal(converge.ok, true);
    assert.equal(converge.created, 1);
    assert.equal(converge.cards?.length, 1);

    // ── [3a] DISTILL/atomic: one entry → one card (not a blob) ──
    const kgDir = path.join(vault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md") && n.startsWith("pi-memory-"));
    assert.equal(cards.length, 1, "one entry → one atomic card");

    // ── [3b] RETRIEVAL: the card is findable by its tag space ──
    const retrieved = await retrieveRecords({
      vaultPath: vault,
      tags: ["pi-memory", "failure"],
      topK: 10,
    });
    assert.ok(retrieved.count >= 1, "retrieval surfaces the converged card");
    assert.ok(
      retrieved.cards.some((c) => c.detail.includes("mlx venv")),
      "the card's content is in the retrieval digest",
    );

    // ── [3c] MERGE: no spurious duplicates (idempotent converge + clean graph) ──
    const merge = await mergeDuplicatesFromMerge({ vaultPath: vault, threshold: 0.9, dryRun: false });
    assert.equal(merge.pairs.length, 0, "no duplicate concepts to merge");
    assert.equal(merge.merged, 0);

    // ── [3d] GRAPH-HEALTH guard: heal + audit leaves the graph clean ──
    await healGraph({ vaultPath: vault });
    const health = await graphHealth({ vaultPath: vault });
    assert.equal(health.deadLinks.length, 0, "0 dead links after heal");
    assert.equal(health.mocMissing, false, "MOC present");
    assert.equal(health.mocStale, false, "MOC not stale");
  });

  it("retired/superseded cards are NOT surfaced by retrieval (purge works)", async () => {
    // Converge an active entry, then manually retire a second card and confirm
    // retrieveRecords excludes it (status filter + _archive/ exclusion).
    await convergeToVault(["Active durable fact about the build system."], "memory", vault);

    // Hand-write a RETIRED card directly in the flat folder (simulates a legacy
    // retired card that wasn't moved yet — the status filter must catch it).
    const retiredPath = path.join(vault, "Zettelkasten", "knowledge-graph", "legacy-retired-card.md");
    fs.writeFileSync(
      retiredPath,
      [
        "---",
        'id: "legacy:retired"',
        "created: 2026-01-01",
        "tags: [zettel, pattern, pi-memory]",
        "source_id: legacy:retired",
        "record_type: pattern",
        "status: retired",
        "superseded_by: \"\"",
        "confidence: 0.5",
        "---",
        "# RETIRED legacy card",
        "",
        "## 核心想法",
        "An old superseded fact about the build system.",
        "",
        "## 證據 / 脈絡",
        "- status: retired",
        "",
        "## 連結",
        "- (none)",
        "",
      ].join("\n"),
    );

    const retrieved = await retrieveRecords({
      vaultPath: vault,
      tags: ["pi-memory", "build"],
      topK: 20,
    });
    // The active card may surface, but the RETIRED card must NEVER appear.
    assert.ok(
      !retrieved.cards.some((c) => c.id === "legacy:retired" || c.title.includes("RETIRED")),
      "retired cards must not be surfaced as live knowledge",
    );
  });
});
