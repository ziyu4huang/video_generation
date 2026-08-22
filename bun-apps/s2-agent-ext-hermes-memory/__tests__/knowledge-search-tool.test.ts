import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishSeam, type KnowledgePipeline, type RetrieveResult } from "@repo/s2-agent-core-interface";
import { registerKnowledgeSearchTool } from "../src/tools/knowledge-search-tool.js";

const KEY = "__piKnowledgePipeline";

/** A zk-shaped stub whose `retrieveRecords` returns the fixed `result`. */
function makeStubPipeline(result: RetrieveResult): KnowledgePipeline {
  return {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (_records, opts) => ({
      source: opts.source, sourceLabel: opts.sourceLabel, total: 0, created: 0, updated: 0,
      unchanged: 0, skipped: 0, linked: 0, wikiMerged: 0, mocUpdated: false,
      vaultPath: opts.vaultPath, folder: opts.folder ?? "", cards: [], parseErrors: [],
    }),
    retrieveRecords: async () => result,
    healGraph: async () => ({ mocRegenerated: true, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] }),
  };
}

/** Minimal registrar: captures the registered ToolDefinition so the test can
 *  drive its `execute`. Structurally assignable to the tool's narrow param type
 *  (no cast needed). */
function captureRegistrar(): { registerTool(def: ToolDefinition): void; def(): ToolDefinition | undefined } {
  let captured: ToolDefinition | undefined;
  return {
    registerTool(def: ToolDefinition): void {
      captured = def;
    },
    def(): ToolDefinition | undefined {
      return captured;
    },
  };
}

function textOf(out: { content: Array<{ type: string; text: string }> }): string {
  return out.content.map((c) => c.text).join("\n");
}

describe("knowledge_search tool", () => {
  let vault: string;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    vault = mkdtempSync(join(tmpdir(), "kst-vault-"));
    process.env.KNOWLEDGE_VAULT_PATH = vault;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    rmSync(vault, { recursive: true, force: true });
  });

  it("surfaces retrieveRecords cards (title in text; RetrieveResult in details)", async () => {
    const fixed: RetrieveResult = {
      count: 1,
      cards: [
        { id: "cfg-scale", title: "CFG Scale Lever", detail: "lower cfg for finer detail", tags: ["zettel", "cfg"] },
      ],
      digest: "1 match · ranked by shared tags",
      folder: "Zettelkasten/knowledge-graph",
      scanned: 5,
      excluded: 0,
    };
    publishSeam(KEY, makeStubPipeline(fixed));

    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const def = pi.def();
    assert.ok(def, "knowledge_search tool registered");
    assert.equal(def!.name, "knowledge_search");
    assert.deepEqual(def!.gating, { gate: "knowledge_search" }); // demoted from core (ticket 02)

    const out = await def!.execute("call-1", { query: "cfg-scale" }, undefined, undefined, { });
    assert.match(textOf(out), /CFG Scale Lever/, "text contains the card title");
    assert.equal((out.details as RetrieveResult).count, 1);
    assert.equal((out.details as RetrieveResult).cards[0]!.id, "cfg-scale");
  });

  it("returns a graceful 'zk not present' result when the seam is absent", async () => {
    // Seam deliberately NOT published.
    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const def = pi.def();
    assert.ok(def);
    const out = await def!.execute("call-1", { query: "anything" }, undefined, undefined, { });
    assert.match(textOf(out), /zk.*not present|seam not present/i);
    assert.equal((out.details as { ok: boolean }).ok, false);
  });

  it("surfaces a clear message when the vault env is unset (resolver throws)", async () => {
    const fixed: RetrieveResult = {
      count: 0, cards: [], digest: "", folder: "Zettelkasten/knowledge-graph", scanned: 0, excluded: 0,
    };
    publishSeam(KEY, makeStubPipeline(fixed));
    const pi = captureRegistrar();
    // A resolver that throws (mirrors resolveKnowledgeVaultPath when both envs unset).
    registerKnowledgeSearchTool(pi, () => {
      throw new Error("knowledge vault path not configured");
    });
    const def = pi.def();
    assert.ok(def);
    const out = await def!.execute("call-1", { query: "x" }, undefined, undefined, { });
    assert.match(textOf(out), /vault not configured/i);
  });
});

// The semantic opt-in surface (buildLexicalRecall / buildEntityRecall /
// buildGraphRelationsFetcher + the searchSemantic warm path) was retired
// 2026-08-22 with the card_vectors HNSW path (context-lifecycle ticket 03);
// its tests were deleted with it.
