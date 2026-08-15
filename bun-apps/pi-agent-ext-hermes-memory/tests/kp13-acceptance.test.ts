/**
 * tests/kp13-acceptance.test.ts — ticket 13 (memory-card graduation) acceptance
 * harness, added by Wave C. Asserts the ticket's acceptance bullets as scoped
 * by plans/13-three-waves.md Wave C + specs/13-memory-card-graduation.md:
 *
 *  1. §-entries round-trip into the card-store with no content loss — all 3
 *     memory kinds (memory / user / failure), driven through the Wave C walk
 *     mirror (walkAndIngest step 8d), plus idempotence (re-walk → 0 writes).
 *  2. read/write/query/dedup against the unified store on BOTH backends — a
 *     thin parity check layered on the existing Wave A dual-backend contract
 *     tests (src/store/card-store-dual-backend.test.ts,
 *     src/store/card-store-memory-kinds.test.ts). The surreal leg runs against
 *     an ISOLATED test namespace/database and SKIPS gracefully when no local
 *     SurrealDB server is reachable (skip status is logged).
 *  3. A knowledge-card edit AND a memory-card edit both flow through the SAME
 *     Tier-1 md→db re-index — one walkAndIngest call drives both kinds into
 *     the same store. Depth note (scoped honestly): the memory leg exercises
 *     the full md-wins UPDATE arm (identity compare → updateCard, new in Wave
 *     C). The knowledge leg rides mirrorVaultMdToStore's insert-idempotence
 *     (KnowledgeDedupStrategy skip on id-match — no duplicate rows on re-walk;
 *     per-card md-wins UPDATE for knowledge is ticket 05's full-drift scope,
 *     explicitly out of 13). Both are the same walk receipt.
 *  4. Full-suite green is the package-level `bun test` run (this file ships
 *     inside it) — not asserted in-file.
 *
 * Bullet 3's "same Tier-1 md→db re-index" claim is structural: both mirrors
 * are steps of ONE walkAndIngest orchestrator writing ONE card-store, and the
 * receipt reports both counters (mirrored + memoryMirrored) from that call.
 *
 * Harness hygiene: the zk seam is published on the real slot
 * (`__piKnowledgePipeline`) with no-op ingest/heal, KNOWLEDGE_VAULT_PATH points
 * at a tmp vault, and both are restored after each test (Bun runs files in one
 * globalThis — same pattern as tests/walk-and-ingest-kgllm.test.ts).
 */

import { describe, it, beforeAll, beforeEach, afterEach } from "bun:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { createCardStore } from "../src/store/card-store.js";
import { createBackendBundle } from "../src/store/backend-factory.js";
import { SurrealBackend } from "../src/store/surreal/surreal-backend.js";
import { loadConfig } from "../src/config.js";
import { serializeMetadataFrontmatter } from "../src/store/memory-format.js";
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from "../src/constants.js";
import { publishSeam } from "@repo/pi-agent-ext-core-interface";
import type { IngestOptions, IngestSummary } from "@repo/pi-agent-ext-core-interface";
import type { CardStore } from "../src/store/card-store.js";
import type { Card } from "../src/store/card.js";

// ── shared tmp lifecycle ────────────────────────────────────────────────────

const DIRS: string[] = [];
const STORES: CardStore[] = [];

function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  DIRS.push(dir);
  return dir;
}

async function openStore(memoryDir: string): Promise<CardStore> {
  const store = await createCardStore({ memoryDir });
  STORES.push(store);
  return store;
}

// ── zk seam + vault env (bullet 1 & 3 need the knowledge path armed) ────────

const EMPTY_SUMMARY: IngestSummary = {
  source: "workflow-jsonl",
  sourceLabel: "kp13-acceptance",
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

/** No-op KnowledgePipeline (the walk only needs ingest/heal to resolve). */
function publishNoopSeam(): void {
  publishSeam("__piKnowledgePipeline", {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (_records: unknown, _opts: IngestOptions): Promise<IngestSummary> => EMPTY_SUMMARY,
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
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Frontmatter §-entry with a stable id (the 5d shape the mirror keys on). */
function fm(
  id: string,
  text: string,
  extra: { state?: string; severity?: number; pin?: boolean } = {},
): string {
  return serializeMetadataFrontmatter({
    id,
    text,
    created: "2026-08-15",
    last: "2026-08-15",
    state: extra.state ?? null,
    severity: extra.severity ?? null,
    pin: extra.pin === true ? true : null,
    provenance: null,
    sources: null,
    mwSuccess: null,
    mwFail: null,
  });
}

const MEM_ID_1 = "md-kp13-mem-11111111-1111-1111-1111-111111111111";
const MEM_ID_2 = "md-kp13-mem-22222222-2222-2222-2222-222222222222";
const USER_ID = "md-kp13-usr-33333333-3333-3333-3333-333333333333";
const FAIL_ID_1 = "md-kp13-fail-44444444-4444-4444-4444-444444444444";
const FAIL_ID_2 = "md-kp13-fail-55555555-5555-5555-5555-555555555555";

/** Seed the GLOBAL memory dir's three files with §-entries (state/severity/pin
 *  variety so the no-content-loss assertion covers every envelope field). */
function seedMemoryFiles(memoryDir: string): void {
  fs.writeFileSync(
    path.join(memoryDir, MEMORY_FILE),
    [
      fm(MEM_ID_1, "kp13 acceptance: global memory probe one"),
      fm(MEM_ID_2, "kp13 acceptance: global memory probe two (pinned)", { pin: true }),
    ].join(ENTRY_DELIMITER),
    "utf8",
  );
  fs.writeFileSync(
    path.join(memoryDir, USER_FILE),
    fm(USER_ID, "kp13 acceptance: user profile probe"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(memoryDir, "failures.md"),
    [
      fm(FAIL_ID_1, "[failure] — kp13 acceptance: active failure probe", { state: "active", severity: 2 }),
      fm(FAIL_ID_2, "[tool-quirk] — kp13 acceptance: resolved failure probe", { state: "resolved", severity: 1 }),
    ].join(ENTRY_DELIMITER),
    "utf8",
  );
}

/** A valid zettel vault-md (fenced YAML + `## 核心想法` body) — the shape
 *  KnowledgeSerializer.deserialize accepts. */
function zettel(body: string): string {
  return `---
id: t:kp13-acceptance
tags: [zettel, lever]
created: 2026-08-15
record_type: lever
status: active
---
# kp13 acceptance zettel

## 核心想法
${body}
`;
}

// ── surreal reachability probe (isolated ns/db; skip when server is down) ───

const TEST_SURREAL = { namespace: "test_hermes_kp13c", database: "kp13_wave_c" };

let SURREAL_UP = false;
let SURREAL_PROBED = false;

async function probeSurreal(): Promise<boolean> {
  if (SURREAL_PROBED) return SURREAL_UP;
  SURREAL_PROBED = true;
  try {
    const backend = new SurrealBackend(TEST_SURREAL);
    await backend.init();
    await backend.healthCheck();
    await backend.close();
    SURREAL_UP = true;
  } catch {
    SURREAL_UP = false;
  }
  console.log(
    `[kp13-acceptance] surreal backend: ${SURREAL_UP ? "reachable — parity leg runs" : "SKIPPED (no local SurrealDB server)"}`,
  );
  return SURREAL_UP;
}

// ── the harness ─────────────────────────────────────────────────────────────

describe("kp13 acceptance — ticket 13 (memory-card graduation, Wave C)", () => {
  const prevVaultEnv = process.env.KNOWLEDGE_VAULT_PATH;
  let vault: string;
  let memoryDir: string;
  let walkInput: string;

  beforeEach(() => {
    vault = freshDir("kp13-accept-vault-");
    memoryDir = freshDir("kp13-accept-memory-");
    walkInput = freshDir("kp13-accept-input-");
    process.env.KNOWLEDGE_VAULT_PATH = vault;
    publishNoopSeam();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
    if (prevVaultEnv === undefined) delete process.env.KNOWLEDGE_VAULT_PATH;
    else process.env.KNOWLEDGE_VAULT_PATH = prevVaultEnv;
  });

  beforeAll(async () => {
    await probeSurreal();
  });

  // ── bullet 1: §-entries round-trip, no content loss, 3 kinds ─────────────
  it("bullet 1: MEMORY.md/USER.md/failures.md §-entries round-trip into the card-store with no content loss (3 kinds) + idempotent re-walk", async () => {
    seedMemoryFiles(memoryDir);

    const receipt = await walkAndIngest([walkInput], { memoryDir });
    assert.equal(receipt.ok, true, "walk with published seam must be ok");
    assert.equal(receipt.memoryMirrored, 5, "all 5 §-entries mirror on first walk (3 kinds)");

    const store = await openStore(memoryDir);
    // kind memory — both entries, exact content + envelope.
    const memoryCards = (await store.getCardsByKind("memory")).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(memoryCards.length, 2);
    assert.equal(memoryCards[0]!.id, MEM_ID_1, "card id == the §-entry frontmatter id (md_id key)");
    assert.equal(memoryCards[0]!.content, "kp13 acceptance: global memory probe one");
    assert.equal(memoryCards[1]!.id, MEM_ID_2);
    assert.equal(memoryCards[1]!.content, "kp13 acceptance: global memory probe two (pinned)");
    assert.equal(memoryCards[1]!.frontmatter.pin, true, "pin survives the round-trip on the envelope");
    assert.equal(memoryCards[0]!.frontmatter.created, "2026-08-15", "created survives");
    assert.equal(memoryCards[0]!.frontmatter.last, "2026-08-15", "last survives");
    // kind user.
    const userCards = await store.getCardsByKind("user");
    assert.equal(userCards.length, 1);
    assert.equal(userCards[0]!.id, USER_ID);
    assert.equal(userCards[0]!.content, "kp13 acceptance: user profile probe");
    // kind failure — state + severity survive per entry.
    const failureCards = (await store.getCardsByKind("failure")).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(failureCards.length, 2);
    assert.equal(failureCards[0]!.id, FAIL_ID_1);
    assert.match(failureCards[0]!.content, /active failure probe/);
    assert.equal(failureCards[0]!.frontmatter.state, "active");
    assert.equal(failureCards[0]!.frontmatter.severity, 2);
    assert.equal(failureCards[1]!.frontmatter.state, "resolved");
    assert.equal(failureCards[1]!.frontmatter.severity, 1);

    // Idempotence (lazy re-migration contract): re-walk → zero writes, same rows.
    const second = await walkAndIngest([walkInput], { memoryDir });
    assert.equal(second.memoryMirrored, 0, "unchanged entries identity-compare-skip on re-walk");
    const memoryCards2 = await store.getCardsByKind("memory");
    assert.equal(memoryCards2.length, 2, "no duplicate rows on re-walk");
  });

  // ── bullet 3: knowledge + memory edits flow through ONE Tier-1 walk ──────
  it("bullet 3: a knowledge-card edit and a memory-card edit both flow through the same walkAndIngest md→db re-index", async () => {
    // Knowledge side: a zettel in the vault folder.
    const zettelDir = path.join(vault, "Zettelkasten", "knowledge-graph");
    fs.mkdirSync(zettelDir, { recursive: true });
    fs.writeFileSync(path.join(zettelDir, "kp13-acceptance.md"), zettel("original knowledge body"), "utf8");
    // Memory side: a MEMORY.md entry.
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      fm(MEM_ID_1, "original memory body"),
      "utf8",
    );

    // ONE walk mirrors BOTH kinds into the SAME store.
    const first = await walkAndIngest([walkInput], { memoryDir });
    assert.ok(first.mirrored >= 1, `knowledge vault-md mirrored (receipt.mirrored=${first.mirrored})`);
    assert.equal(first.memoryMirrored, 1, "memory §-entry mirrored in the same walk");

    const store = await openStore(memoryDir);
    const knowledge = await store.getCard("t:kp13-acceptance");
    assert.ok(knowledge, "knowledge card mirrored into the unified store");
    assert.equal(knowledge!.kind, "knowledge");
    assert.equal(knowledge!.content, "original knowledge body");
    const memoryCard = await store.getCard(MEM_ID_1);
    assert.ok(memoryCard, "memory card mirrored into the same unified store");
    assert.equal(memoryCard!.content, "original memory body");

    // EDIT both md sources, then re-run the same walk (the Tier-1 re-index).
    fs.writeFileSync(path.join(zettelDir, "kp13-acceptance.md"), zettel("edited knowledge body"), "utf8");
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      fm(MEM_ID_1, "edited memory body"),
      "utf8",
    );
    const second = await walkAndIngest([walkInput], { memoryDir });

    // Memory leg: md WINS — the row UPDATEs in place (id stable). This is the
    // Wave C Tier-1 mechanism (identity compare → updateCard).
    assert.equal(second.memoryMirrored, 1, "the drifted memory entry re-indexes (UPDATE, not skip)");
    const editedMemory = await store.getCard(MEM_ID_1);
    assert.ok(editedMemory);
    assert.equal(editedMemory!.content, "edited memory body", "md edit propagates into the store (md wins)");
    assert.equal(editedMemory!.id, MEM_ID_1, "id stays stable across the md-wins update");

    // Knowledge leg: the edited md re-flows through the SAME mirror step
    // idempotently — exactly one row for the id, never duplicated (per-card
    // md-wins UPDATE for knowledge is ticket 05's full-drift scope, out of 13).
    const knowledgeList = await store.getCardsByKind("knowledge");
    const same = knowledgeList.filter((c) => c.id === "t:kp13-acceptance");
    assert.equal(same.length, 1, "knowledge re-walk inserts no duplicate row");
  });
});

// ── bullet 2: thin dual-backend parity (read/write/query/dedup) ─────────────

describe("kp13 acceptance — unified-store parity on both backends (thin)", () => {
  /** The SAME thin contract body: write (upsert ×2 → exact-dup dedup keeps ONE
   *  row), read (getCard identity), query (getCardsByKind), update
   *  (updateCard in place), delete (deleteCard). */
  async function parityBody(store: CardStore, tag: string): Promise<void> {
    const id = `memory:kp13c-parity-${tag}`;
    const card: Card = {
      id,
      kind: "memory",
      content: `kp13 Wave C parity probe (${tag})`,
      frontmatter: { id, created: "2026-08-15", last: "2026-08-15", state: "active", severity: 2 },
    };
    await store.upsertCard(card);
    await store.upsertCard(card); // exact dup → dedup keeps one row
    const listed = await store.getCardsByKind("memory").then((rows) => rows.filter((c) => c.id === id));
    assert.equal(listed.length, 1, "dedup: re-upserting the identical memory card adds no row");
    const got = await store.getCard(id);
    assert.ok(got, "getCard returns the row");
    assert.equal(got!.content, card.content);
    assert.deepEqual(got!.frontmatter, card.frontmatter, "envelope round-trips identically");
    await store.updateCard({ ...card, content: `kp13 Wave C parity probe (${tag}) — updated` });
    const updated = await store.getCard(id);
    assert.equal(updated!.content, `kp13 Wave C parity probe (${tag}) — updated`, "updateCard refreshes in place");
    await store.deleteCard(id);
    assert.equal(await store.getCard(id), null, "deleteCard removes the row");
  }

  it("sqlite backend: memory-kind write/read/query/dedup/update/delete against the unified store", async () => {
    const dir = freshDir("kp13-parity-sqlite-");
    const store = await openStore(dir);
    await parityBody(store, "sqlite");
  });

  it("surrealdb backend: memory-kind write/read/query/dedup/update/delete against the unified store (skips when server is down)", async () => {
    if (!(await probeSurreal())) return; // graceful skip — status logged above
    const bundle = await createBackendBundle(
      { ...loadConfig(path.join(os.tmpdir(), "kp13c-nonexistent-config.json")), dbBackend: "surrealdb", surreal: TEST_SURREAL },
      "unused-memory-dir",
    );
    try {
      await parityBody(bundle.cardStore, "surreal");
    } finally {
      await bundle.backend.close();
    }
  });
});

// ── final cleanup (after both describes) ────────────────────────────────────

afterEach(async () => {
  while (STORES.length) {
    try {
      await STORES.pop()!.close();
    } catch {
      /* ignore */
    }
  }
});

process.on("exit", () => {
  for (const dir of DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
