// src/config-kg-llm-model.test.ts — ticket 04: kgLlmModel config plumbing.
// Precedence chain: call-opts > config-file > env (PI_KG_LLM_MODEL). The env
// fallback is TERMINAL in zk's ingest.ts — hermes deliberately never reads it,
// so at the hermes boundary an absent opt must arrive as undefined, leaving
// zk's env fallback in charge. These tests pin (1) loadConfig parity for the
// config-file layer and (2) the funnel behavior at walkAndIngest's
// ingestRecords call. config>env is exercised structurally: the composition
// site seeds config.kgLlmModel into the tool opts (composition/tools.ts), so
// a walk-opt carrying the config value beats env once it reaches zk.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishSeam,
  type IngestOptions,
  type IngestSummary,
  type KnowledgePipeline,
} from "@repo/s2-agent-core-interface";
import { __setAgentRootForTest } from "./paths.js";
import { loadConfig } from "./config.js";
import { walkAndIngest } from "./walk-and-ingest.js";

/** Minimal fake KnowledgePipeline: ingestRecords CAPTURES the opts it is
 *  handed (the precedence probe); every leaf returns a shaped, empty receipt
 *  so the walk-and-ingest flow completes without zk. */
function fakePipeline(captured: IngestOptions[]): KnowledgePipeline {
  const summary = (opts: IngestOptions): IngestSummary => ({
    source: opts.source,
    sourceLabel: opts.sourceLabel,
    total: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    linked: 0,
    wikiMerged: 0,
    mocUpdated: false,
    vaultPath: opts.vaultPath,
    folder: opts.folder ?? "",
    cards: [],
    parseErrors: [],
  });
  return {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (_records, opts) => {
      captured.push(opts);
      return summary(opts);
    },
    healGraph: async () => ({ mocRegenerated: false, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] }),
    buildHierarchy: async () => ({ layers: 0, nodes: [], llmCalls: 0, resumed: false }),
    retrieveRecords: async () => ({ count: 0, cards: [], digest: "", folder: "", scanned: 0, excluded: 0 }),
  };
}

/** Env save/restore helper — restore exact prior state (unset stays unset). */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}

describe("kgLlmModel config plumbing (ticket 04)", () => {
  it("loadConfig reads kgLlmModel from the config file; blank stays unset", async (t) => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "hermes-kg-llm-"));
    t.after(() => {
      __setAgentRootForTest(null);
      rmSync(tmpRoot, { recursive: true, force: true });
    });
    __setAgentRootForTest(tmpRoot);
    const noOverlayCwd = join(tmpdir(), "hermes-kg-llm-no-overlay");
    writeFileSync(join(tmpRoot, "hermes-memory-config.json"), JSON.stringify({ kgLlmModel: "cfg-model" }));
    assert.equal(loadConfig(undefined, noOverlayCwd).kgLlmModel, "cfg-model");
    // Trim guard: whitespace-only is dropped, not stored as whitespace.
    writeFileSync(join(tmpRoot, "hermes-memory-config.json"), JSON.stringify({ kgLlmModel: "   " }));
    assert.equal(loadConfig(undefined, noOverlayCwd).kgLlmModel, undefined);
  });

  it("walkAndIngest threads opts.kgLlmModel into ingestRecords; env is NOT read at the hermes boundary", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-kg-funnel-"));
    const vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    // One parseable workflow-jsonl record so the walk hands ingestRecords a
    // non-empty batch (parser requires non-empty id + title only).
    writeFileSync(join(vault, "probe.knowledge.jsonl"), `${JSON.stringify({ id: "kg-1", title: "Funnel probe", detail: "d" })}\n`);
    const captured: IngestOptions[] = [];
    // Defensive: clear any seam leaked by an earlier test file, then publish.
    delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
    publishSeam("__piKnowledgePipeline", fakePipeline(captured));
    const savedVault = process.env.KNOWLEDGE_VAULT_PATH;
    const savedEnvModel = process.env.PI_KG_LLM_MODEL;
    process.env.KNOWLEDGE_VAULT_PATH = vault;
    process.env.PI_KG_LLM_MODEL = "env-model";
    t.after(() => {
      delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
      restoreEnv("KNOWLEDGE_VAULT_PATH", savedVault);
      restoreEnv("PI_KG_LLM_MODEL", savedEnvModel);
      rmSync(dir, { recursive: true, force: true });
    });

    // opts > env: explicit walk-opt wins over the env var.
    await walkAndIngest([vault], { memoryDir: join(dir, "store"), kgLlmModel: "opts-model" });
    // opts absent: hermes passes nothing (env fallback stays zk-terminal).
    await walkAndIngest([vault], { memoryDir: join(dir, "store") });

    assert.equal(captured.length, 2, "both walks reached the ingestRecords funnel");
    assert.equal(captured[0]?.kgLlmModel, "opts-model");
    assert.equal(captured[1]?.kgLlmModel, undefined);
  });
});
