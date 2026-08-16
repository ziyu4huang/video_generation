/**
 * End-to-end acceptance for the 06b knowledge spine (task 8). Exercises the
 * REAL hermes orchestration logic — walkAndIngest (walk → parse → ingest-trigger
 * → heal-trigger → DB-mirror) + knowledge_search (retrieve-trigger + format) +
 * the 06a card-store mirror + drift stub — against a REALISTIC zk-shaped
 * KnowledgePipeline stub.
 *
 * The stub is honest about the zk seam's contract (it writes REAL zettel
 * vault-md, regenerates a MOC, and `retrieveRecords` actually scans the written
 * vault-md + matches by tag and ranks by shared-tag count). The logic UNDER
 * test — hermes's walk/parse/mirror/search + the 06a serializer/dedup/store —
 * is NOT mocked: it runs for real. zk's own library (ingest/retrieve/heal) is
 * exercised by zk's 389-test suite and stays byte-unchanged by 06b.
 *
 * zk is NOT a hermes dependency (and pulls obsidian's deep parse web), so the
 * stub stands in for the seam rather than importing zk directly — per the
 * plan's option (a).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  publishSeam,
  type KnowledgePipeline,
  type RetrieveResult,
  type RetrievedCard,
} from "@repo/pi-agent-core-interface";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { createCardStore } from "../src/store/card-store.js";
import { registerKnowledgeSearchTool } from "../src/tools/knowledge-search-tool.js";

const KEY = "__piKnowledgePipeline";
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

/** Emit the zettel vault-md zk's renderCard produces (valid for the 06a
 *  KnowledgeSerializer). Idempotent at the file level — a card that already
 *  exists is left untouched (models zk's no-op for unchanged records), so an
 *  external edit persists across re-ingest. */
function emitZettel(vaultPath: string, r: {
  id: string; title: string; detail: string; tags: string[];
}): { path: string; created: boolean } {
  const dir = join(vaultPath, FOLDER);
  mkdirSync(dir, { recursive: true });
  const slug = r.id.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  const fp = join(dir, `${slug}.md`);
  if (existsSync(fp)) return { path: `${FOLDER}/${slug}.md`, created: false };
  const fmTags = ["zettel", ...r.tags.filter((t) => t !== "zettel")];
  const body = [
    "---",
    `id: ${r.id}`,
    "created: 2026-01-01",
    `tags: [${fmTags.join(", ")}]`,
    "---",
    `# ${r.title}`,
    "",
    "## 核心想法",
    r.detail,
    "",
    "## 連結",
    "",
  ].join("\n");
  writeFileSync(fp, body + "\n");
  return { path: `${FOLDER}/${slug}.md`, created: true };
}

/** A realistic zk-shaped KnowledgePipeline: ingest writes zettel vault-md;
 *  heal regenerates the MOC; retrieve scans the convergence folder and matches
 *  by tag (ranked by shared-tag count) + optional body/queryText match. */
function makeRealisticPipeline(): KnowledgePipeline {
  return {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (records, opts) => {
      let created = 0;
      const cards = records.map((r) => {
        const out = emitZettel(opts.vaultPath, {
          id: r.id,
          title: r.title,
          detail: r.detail || r.title,
          tags: Array.isArray(r.tags) ? r.tags : [],
        });
        if (out.created) created++;
        return { id: r.id, path: out.path, status: out.created ? "created" : "unchanged", links: 0 };
      });
      return {
        source: opts.source, sourceLabel: opts.sourceLabel, total: records.length,
        created, updated: 0, unchanged: records.length - created, skipped: 0, linked: 0, wikiMerged: 0,
        mocUpdated: false, vaultPath: opts.vaultPath, folder: opts.folder ?? "", cards, parseErrors: [],
      };
    },
    runConvergenceLoop: async () => ({
      sourcesIngested: 0, created: 0, updated: 0, unchanged: 0, deadLinksBefore: 0, deadLinksAfter: 0,
      mocMissingBefore: false, mocMissingAfter: false, rounds: 0, converged: false, truncated: false, health: null,
    }),
    healGraph: async (opts) => {
      const dir = join(opts.vaultPath, opts.folder ?? FOLDER);
      let cards: string[] = [];
      try {
        cards = readdirSync(dir)
          .filter((n) => n.endsWith(".md"))
          .map((n) => `${opts.folder ?? FOLDER}/${n}`);
      } catch {
        cards = [];
      }
      // Regenerate the MOC from on-disk cards (mirrors zk's writeMoc).
      const mocAbs = join(opts.vaultPath, opts.mocPath ?? MOC);
      mkdirSync(dirname(mocAbs), { recursive: true });
      writeFileSync(
        mocAbs,
        `# Knowledge Graph\n\n${cards.map((c) => `- [[${c.replace(/\.md$/, "")}]]`).join("\n")}\n`,
      );
      return { mocRegenerated: true, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: cards };
    },
    retrieveRecords: async (opts) => {
      const dir = join(opts.vaultPath, opts.folder ?? FOLDER);
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
      } catch {
        files = [];
      }
      const want = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
      const qText = (opts.queryText ?? "").toLowerCase();
      const exclude = new Set(opts.excludeIds ?? []);
      const matched: Array<{ card: RetrievedCard; shared: number }> = [];
      let scanned = 0;
      for (const name of files) {
        scanned++;
        let bytes = "";
        try {
          bytes = readFileSync(join(dir, name), "utf8");
        } catch {
          continue;
        }
        const fm = bytes.match(/^---\n([\s\S]*?)\n---/);
        const fmText = fm ? fm[1]! : "";
        const idMatch = fmText.match(/^id:\s*(.+)/m);
        const id = idMatch ? idMatch[1]!.trim() : name.replace(/\.md$/, "");
        if (exclude.has(id)) continue;
        const tagLine = fmText.match(/^tags:\s*\[(.*)\]/m);
        const tags = tagLine
          ? tagLine[1]!.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const titleMatch = bytes.match(/^# (.+)$/m);
        const title = titleMatch ? titleMatch[1]!.trim() : id;
        const detailMatch = bytes.match(/## 核心想法\n([\s\S]*?)(?:\n## |\n?$)/);
        const detail = detailMatch ? detailMatch[1]!.trim() : "";
        const shared = tags.filter((t) => want.has(t.toLowerCase())).length;
        const bodyHit = opts.bodyMatch && qText.length > 0 && bytes.toLowerCase().includes(qText);
        if (shared > 0 || bodyHit) {
          matched.push({ card: { id, title, detail, tags }, shared });
        }
      }
      matched.sort((a, b) => b.shared - a.shared);
      const topK = opts.topK ?? 10;
      const cards = matched.slice(0, topK).map((m) => m.card);
      return {
        count: cards.length,
        cards,
        digest: cards.length > 0 ? `${cards.length} match(es) · ranked by shared tags` : "",
        folder: opts.folder ?? FOLDER,
        scanned,
        excluded: exclude.size,
      };
    },
  };
}

/** Minimal tool registrar capturing the registered ToolDefinition (structurally
 *  assignable to the tool's narrow param — no cast needed). */
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

describe("knowledge-pipeline 06b end-to-end (walk → ingest → heal → mirror → search)", () => {
  let vault: string;
  let inputDir: string;
  let memDir: string;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    vault = mkdtempSync(join(tmpdir(), "e2e-vault-"));
    inputDir = mkdtempSync(join(tmpdir(), "e2e-input-"));
    memDir = mkdtempSync(join(tmpdir(), "e2e-mem-"));
    process.env.KNOWLEDGE_VAULT_PATH = vault;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    rmSync(vault, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  });

  it("runs the full loop and is idempotent on re-run", async () => {
    // ── Fixture: 3 records across lever/gotcha/pattern + junk to skip ──
    const jsonl = [
      '{"id":"r-cfg","type":"lever","title":"CFG Scale Tuning","detail":"lower cfg for finer detail","tags":["cfg","lever"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r-sampler","type":"gotcha","title":"Sampler Euler A Gotcha","detail":"euler-a vs euler","tags":["sampler","gotcha"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
      '{"id":"r-seed","type":"pattern","title":"Seed Reuse Pattern","detail":"reuse seeds for variants","tags":["seed","pattern"],"dimension":null,"confidence":1,"status":"active","superseded_by":null}',
    ].join("\n");
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), jsonl);

    // Junk to skip.
    mkdirSync(join(inputDir, ".git"), { recursive: true });
    writeFileSync(join(inputDir, ".git", "config"), "junk");
    writeFileSync(join(inputDir, "blob.zip"), "PK");
    writeFileSync(join(inputDir, "pic.png"), "PNG");
    symlinkSync(join(inputDir, "run.knowledge.jsonl"), join(inputDir, "link.knowledge.jsonl"));
    // .agents/memory must be untouched (out of scope; deferredFamily).
    mkdirSync(join(inputDir, ".agents", "memory"), { recursive: true });
    writeFileSync(join(inputDir, ".agents", "memory", "MEMORY.md"), "# MARKER must survive\n");

    publishSeam(KEY, makeRealisticPipeline());

    // ── 1. walkAndIngest: walk → parse → ingest → heal → mirror ──
    const r1 = await walkAndIngest(inputDir, { memoryDir: memDir });
    assert.equal(r1.ok, true);
    assert.equal(r1.seamPresent, true);

    // (1) vault-md cards written under <vault>/<folder>/.
    const folderDir = join(vault, FOLDER);
    assert.ok(existsSync(folderDir), "convergence folder created");
    const mds = readdirSync(folderDir).filter((n) => n.endsWith(".md"));
    assert.ok(mds.length >= 3, `≥3 vault-md cards written (got ${mds.length})`);

    // (2) healGraph receipt non-empty (MOC regenerated; cards touched).
    assert.ok(r1.heal, "heal receipt present");
    assert.equal(r1.heal!.mocRegenerated, true);
    assert.ok((r1.heal!.cardsTouched?.length ?? 0) >= 3, "heal touched ≥3 cards");
    assert.ok(existsSync(join(vault, MOC)), "MOC note written");

    // (3) DB mirror holds the cards (ids == the ingested record ids).
    assert.ok(r1.mirrored >= 3, `mirrored ≥3 (got ${r1.mirrored})`);
    const store1 = await createCardStore({ memoryDir: memDir });
    let mirroredIds: string[];
    try {
      const cards = await store1.getCardsByKind("knowledge");
      mirroredIds = cards.map((c) => c.id);
      assert.ok(mirroredIds.length >= 3);
      for (const id of ["r-cfg", "r-sampler", "r-seed"]) {
        assert.ok(mirroredIds.includes(id), `mirror holds ${id}`);
      }
    } finally {
      await store1.close();
    }

    // (5) junk is in skipped; (6) .agents/memory untouched + deferred.
    assert.ok(r1.skipped.dirs.some((d) => d.endsWith(".git")), ".git skipped");
    assert.ok(r1.skipped.binaries.some((b) => b.endsWith("blob.zip")), "blob.zip skipped");
    assert.ok(r1.skipped.binaries.some((b) => b.endsWith("pic.png")), "pic.png skipped (image default off)");
    assert.ok(r1.skipped.symlinks.some((s) => s.endsWith("link.knowledge.jsonl")), "symlink skipped");
    assert.ok(
      r1.skipped.deferredFamily.some((f) => f.endsWith("MEMORY.md")),
      ".agents/memory/MEMORY.md in deferredFamily",
    );
    const memoryAfter = readFileSync(join(inputDir, ".agents", "memory", "MEMORY.md"), "utf8");
    assert.equal(memoryAfter, "# MARKER must survive\n", ".agents/memory byte-untouched");

    // ── 2. knowledge_search surfaces a matching card via retrieveRecords ──
    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const searchDef = pi.def();
    assert.ok(searchDef, "knowledge_search registered");
    const out = await searchDef!.execute("e2e-1", { query: "cfg" }, undefined, undefined, {});
    const details = out.details as RetrieveResult;
    assert.ok(details.count >= 1, `knowledge_search matched ≥1 card (got ${details.count})`);
    assert.ok(
      textOf(out).includes("CFG Scale Tuning"),
      `search text surfaces the cfg card title (got: ${textOf(out)})`,
    );
    assert.equal(details.cards[0]!.id, "r-cfg", "top match is the cfg card");

    // ── 3. Re-running walkAndIngest is idempotent (no dup rows; stable mirror) ──
    const r2 = await walkAndIngest(inputDir, { memoryDir: memDir, previousHashes: r1.driftStub.currentHashes });
    assert.equal(r2.mirrored, r1.mirrored, "mirrored stable on re-run");
    assert.deepEqual(r2.driftStub.currentHashes, r1.driftStub.currentHashes, "vault-md byte-stable (hashes identical)");
    const store2 = await createCardStore({ memoryDir: memDir });
    try {
      const cards2 = await store2.getCardsByKind("knowledge");
      assert.equal(cards2.length, mirroredIds.length, "no duplicate DB rows after re-run");
    } finally {
      await store2.close();
    }

    // knowledge_search still works after re-run (seam intact, vault-md unchanged).
    const out2 = await searchDef!.execute("e2e-2", { query: "sampler" }, undefined, undefined, {});
    const details2 = out2.details as RetrieveResult;
    assert.ok(details2.count >= 1);
    assert.ok(textOf(out2).includes("Sampler Euler A Gotcha"));
  });

  it("degrades gracefully end-to-end when the zk seam is absent", async () => {
    writeFileSync(join(inputDir, "run.knowledge.jsonl"), '{"id":"x","title":"X"}');
    // Seam deliberately NOT published.
    const r = await walkAndIngest(inputDir, { memoryDir: memDir });
    assert.equal(r.ok, false);
    assert.equal(r.seamPresent, false);

    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const out = await pi.def()!.execute("e2e-3", { query: "x" }, undefined, undefined, {});
    assert.match(textOf(out), /zk.*not present|seam not present/i);
  });
});
