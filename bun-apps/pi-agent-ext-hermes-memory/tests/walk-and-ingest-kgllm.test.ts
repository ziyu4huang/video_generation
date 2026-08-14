/**
 * tests/walk-and-ingest-kgllm.test.ts — FIX 1 (whole-branch review): verifies
 * `MemoryConfig.kgLlm` reaches zk's ingest gate. The wiring chain is
 * config.ts (parse) → index.ts (registerKnowledgeIngestTool opts) →
 * WalkAndIngestOptions.kgLlm → kp.ingestRecords IngestOptions.kgLlm. Before
 * the fix, only the `PI_KG_LLM=1` env fallback worked — the config-file flag
 * was parsed and dropped.
 *
 * Harness: publish a MOCK KnowledgePipeline on the real seam slot
 * (`__piKnowledgePipeline`, via core-interface's publishSeam — the same slot
 * `getKnowledgePipeline()` reads defensively) whose ingestRecords/healGraph
 * captures the IngestOptions. KNOWLEDGE_VAULT_PATH points at a temp dir so the
 * vault resolver succeeds; the walk input is an empty temp dir (zero records —
 * ingestRecords is still invoked with the options object under test).
 * The seam slot + env are restored after each test (Bun runs files in one
 * globalThis — hygiene matters for sibling tests).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { publishSeam } from "@repo/pi-agent-ext-core-interface";
import type { IngestOptions, IngestSummary } from "@repo/pi-agent-ext-core-interface";

const EMPTY_SUMMARY: IngestSummary = {
  source: "workflow-jsonl",
  sourceLabel: "test",
  total: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  linked: 0,
  wikiMerged: 0,
  mocUpdated: false,
  vaultPath: "",
  folder: "Zettelkasten/knowledge-graph",
  cards: [],
  parseErrors: [],
};

describe("walkAndIngest — kgLlm seam wiring (FIX 1)", () => {
  const prevVaultEnv = process.env.KNOWLEDGE_VAULT_PATH;
  let tmp = "";
  const captured: IngestOptions[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walk-ingest-kgllm-"));
    process.env.KNOWLEDGE_VAULT_PATH = tmp;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
    if (prevVaultEnv === undefined) delete process.env.KNOWLEDGE_VAULT_PATH;
    else process.env.KNOWLEDGE_VAULT_PATH = prevVaultEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes WalkAndIngestOptions.kgLlm through to kp.ingestRecords IngestOptions", async () => {
    publishSeam("__piKnowledgePipeline", {
      collectInputFiles: () => ({ files: [], skipped: [] }),
      ingestRecords: async (_records, opts) => {
        captured.push(opts);
        return EMPTY_SUMMARY;
      },
      healGraph: async () => ({
        mocRegenerated: false,
        deadLinksPruned: 0,
        linksDeduped: 0,
        cardsTouched: [],
      }),
      runConvergenceLoop: async () => {
        throw new Error("not used in this test");
      },
      retrieveRecords: async () => {
        throw new Error("not used in this test");
      },
    });

    const receipt = await walkAndIngest([tmp], { memoryDir: tmp, kgLlm: true });
    expect(receipt.ok).toBe(true);
    expect(receipt.ingest).toBeDefined();
    expect(captured).toHaveLength(1);
    // THE seam assertion: the flag reached zk's ingest gate.
    expect(captured[0]!.kgLlm).toBe(true);
  });

  it("omits kgLlm from IngestOptions when the caller does not set it (zk env fallback stays authoritative)", async () => {
    publishSeam("__piKnowledgePipeline", {
      collectInputFiles: () => ({ files: [], skipped: [] }),
      ingestRecords: async (_records, opts) => {
        captured.push(opts);
        return EMPTY_SUMMARY;
      },
      healGraph: async () => ({
        mocRegenerated: false,
        deadLinksPruned: 0,
        linksDeduped: 0,
        cardsTouched: [],
      }),
      runConvergenceLoop: async () => {
        throw new Error("not used in this test");
      },
      retrieveRecords: async () => {
        throw new Error("not used in this test");
      },
    });

    await walkAndIngest([tmp], { memoryDir: tmp });
    expect(captured.at(-1)!.kgLlm).toBeUndefined();
  });
});
