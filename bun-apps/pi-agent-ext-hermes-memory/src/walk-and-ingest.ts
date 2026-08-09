import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IngestSummary, HealReceipt, LinkWeighting } from "@repo/pi-agent-ext-core-interface";
import { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";
import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT, KNOWLEDGE_MOC_DEFAULT } from "./knowledge-vault-path.js";
import { walkKnowledgeSources, type WalkOptions } from "./knowledge-walk.js";
import { parseKnowledgeJsonl } from "./knowledge-jsonl.js";
import { AGENT_ROOT } from "./paths.js";
import { createCardStore } from "./store/card-store.js";

/** Options for walkAndIngest. Extends the walk policy opts with ingest/heal scope. */
export interface WalkAndIngestOptions extends WalkOptions {
  /** Convergence folder (default Zettelkasten/knowledge-graph). */
  folder?: string;
  /** MOC note path, vault-relative (default Tags/Knowledge Graph.md). */
  mocPath?: string;
  /** Source label recorded in the IngestSummary. */
  sourceLabel?: string;
  /** Max canonical links per card. */
  maxLinks?: number;
  /** Enable wiki-aware merge. */
  wikiAware?: boolean;
  /** Link ranking weighting. */
  linkWeighting?: LinkWeighting;
  /** The SQLite memory dir backing the 06a unified card-store (the SAME DB the
   *  memory-cards use). Defaults to the existing hermes memory DB dir
   *  (`<AGENT_ROOT>/pi-hermes-memory`) — NEVER inside the obsidian vault. The
   *  mirror opens createCardStore({memoryDir}) against this dir so knowledge
   *  rows land in the same `sessions.db` the memory-cards use. */
  memoryDir?: string;
  /** Previous run's Tier-1 md-hash set (`relPath → sha256`). When provided, the
   *  receipt echoes it as `driftStub.previousHashes` for change-detection
   *  (compare against `currentHashes`). Full drift logic is ticket 05; 06b
   *  captures the hook point only (no re-index action). */
  previousHashes?: Record<string, string>;
}

/** Receipt for a walkAndIngest run. mirrored + driftStub are placeholders in
 *  06b task 4 (the DB-mirror is task 5; the drift stub is task 7). */
export interface WalkAndIngestReceipt {
  ok: boolean;
  vaultPath: string;
  folder: string;
  ingest?: IngestSummary;
  heal?: HealReceipt;
  /** # of vault-md cards mirrored into the card-store (task 5; 0 here). */
  mirrored: number;
  /** Tier-1 md-hash drift hook stub (task 7). `currentHashes` is the sha256 of
   *  each mirrored vault-md file (relPath → hash); `previousHashes` echoes the
   *  opts for change-detection. No re-index action (full drift = ticket 05). */
  driftStub: {
    filesHashed: number;
    previousHashes?: Record<string, string>;
    currentHashes: Record<string, string>;
  };
  skipped: { dirs: string[]; binaries: string[]; symlinks: string[]; deferredFamily: string[] };
  seamPresent: boolean;
  /** Set when ok:false (graceful degradation reason). */
  reason?: string;
}

/** On-demand orchestrator (06b): resolve vault → read seam (graceful) → policy
 *  walk → family detect → adapt workflow-jsonl → kp.ingestRecords (zk writes
 *  vault-md) → kp.healGraph once → receipt. The DB-mirror (step 8) + drift stub
 *  (step 9) land in tasks 5/7. generic family is detected-but-deferred (Option A).
 *  Hermes NEVER calls runConvergenceLoop (Decision 1) and NEVER imports zk. */
export async function walkAndIngest(
  input: string | string[],
  opts: WalkAndIngestOptions = {},
): Promise<WalkAndIngestReceipt> {
  // 1. Resolve vault (env-only; throws a clear error if unset/missing).
  const vaultPath = resolveKnowledgeVaultPath();
  const folder = opts.folder ?? KNOWLEDGE_FOLDER_DEFAULT;
  const mocPath = opts.mocPath ?? KNOWLEDGE_MOC_DEFAULT;

  const emptySkipped = { dirs: [], binaries: [], symlinks: [], deferredFamily: [] };

  // 2. Read the seam (graceful — no throw when zk is absent).
  const kp = getKnowledgePipeline();
  if (!kp) {
    return {
      ok: false,
      vaultPath,
      folder,
      mirrored: 0,
      driftStub: { filesHashed: 0, currentHashes: {} },
      skipped: emptySkipped,
      seamPresent: false,
      reason: "zk KnowledgePipeline seam not present",
    };
  }

  // 3-4. Policy walk + source-family detection (hermes owns the walk).
  const walk = walkKnowledgeSources(input, opts);

  // 5. Adapt workflow-jsonl → KnowledgeRecord[] (Option A; generic deferred).
  const records = [];
  for (const file of walk.files["workflow-jsonl"]) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    records.push(...parseKnowledgeJsonl(content).records);
  }

  // 6. Ingest (leaf). zk writes vault-md; hermes does NOT drive vault-md writes.
  const ingest = await kp.ingestRecords(records, {
    vaultPath,
    source: "workflow-jsonl",
    sourceLabel: opts.sourceLabel ?? "walkAndIngest",
    folder,
    mocPath,
    maxLinks: opts.maxLinks,
    wikiAware: opts.wikiAware,
    linkWeighting: opts.linkWeighting,
  });

  // 7. Heal (leaf, once). hermes decides WHEN; zk provides the primitive.
  const heal = await kp.healGraph({ vaultPath, folder, mocPath });

  // 8. DB-mirror (single dedup site, Decision 4) + 9. Tier-1 drift stub.
  // Read <vaultPath>/<folder>/*.md → KnowledgeSerializer.deserialize →
  // card-store.upsertCard (knowledge kind), capturing the sha256 of each file
  // (Tier-1 md-hash hook point; no re-index action — full drift is ticket 05).
  // The store IS the 06a unified card-store — the SAME SQLite DB the memory-cards
  // use (kind-dispatched; a separate knowledge store would defeat 06a). The DB
  // dir is the existing hermes memory DB dir (`<AGENT_ROOT>/pi-hermes-memory`),
  // NEVER inside the obsidian vault. Re-mirror is idempotent via
  // KnowledgeDedupStrategy (id-upsert). Hermes READS vault-md; it does NOT write it.
  const { mirrored, currentHashes } = await mirrorVaultMdToStore(vaultPath, folder, opts.memoryDir);

  // 10. Receipt.
  return {
    ok: true,
    vaultPath,
    folder,
    ingest,
    heal,
    mirrored,
    driftStub: {
      filesHashed: Object.keys(currentHashes).length,
      previousHashes: opts.previousHashes,
      currentHashes,
    },
    skipped: walk.skipped,
    seamPresent: true,
  };
}

/** Mirror step 8 (Decision 4) + Tier-1 drift stub (step 9): read
 *  `<vaultPath>/<folder>/*.md` → deserialize via the store's knowledge serializer
 *  (the 06a registry) → upsertCard, AND capture the sha256 of each file's bytes
 *  (`relPath → hash`) as the Tier-1 md-hash hook point. The store reuses the SAME
 *  SQLite DB the memory-cards use (`<memoryDir>/sessions.db`); `memoryDir`
 *  defaults to the existing hermes memory DB dir, NEVER inside the vault. Returns
 *  the # of deserialized knowledge cards pushed through the single dedup site
 *  (idempotent — re-mirroring an unchanged corpus yields zero new rows) + the
 *  `currentHashes` map. NO re-index action (full drift = ticket 05). */
async function mirrorVaultMdToStore(
  vaultPath: string,
  folder: string,
  memoryDir?: string,
): Promise<{ mirrored: number; currentHashes: Record<string, string> }> {
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let mirrored = 0;
  const currentHashes: Record<string, string> = {};
  try {
    const serializer = store.serializerFor("knowledge");
    const folderDir = join(vaultPath, folder);
    let mdFiles: string[] = [];
    try {
      mdFiles = readdirSync(folderDir).filter((n) => n.endsWith(".md")).sort();
    } catch {
      // Folder absent (no cards written) → mirror + drift stub are no-ops.
      return { mirrored: 0, currentHashes };
    }
    for (const name of mdFiles) {
      const abs = join(folderDir, name);
      let bytes = "";
      try {
        bytes = readFileSync(abs, "utf8");
      } catch {
        continue; // a partially-flushed/pulled file: skip defensively
      }
      // Tier-1 md-hash hook point (task 7): sha256 of the file bytes, keyed by
      // the vault-relative path. Captured for drift detection; no re-index here.
      const relPath = join(folder, name);
      currentHashes[relPath] = createHash("sha256").update(bytes).digest("hex");
      // KnowledgeSerializer.deserialize tolerates a non-zettel/partial file → []
      // (defensive; never throws on one malformed vault file).
      const cards = serializer ? serializer.deserialize(bytes, { filePath: relPath }) : [];
      for (const card of cards) {
        await store.upsertCard(card);
        mirrored++;
      }
    }
  } finally {
    await store.close();
  }
  return { mirrored, currentHashes };
}
