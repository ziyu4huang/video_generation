import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IngestSummary, HealReceipt, LinkWeighting } from "@repo/pi-agent-ext-core-interface";
import { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";
import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT, KNOWLEDGE_MOC_DEFAULT } from "./knowledge-vault-path.js";
import { walkKnowledgeSources, type WalkOptions } from "./knowledge-walk.js";
import { parseKnowledgeJsonl } from "./knowledge-jsonl.js";
import { hasMergeConflictMarkers } from "./git-ops.js";
import { AGENT_ROOT } from "./paths.js";
import { createCardStore, type CardStore } from "./store/card-store.js";
import type { CardKind } from "./store/card.js";
import type { VectorStore } from "./store/surreal/vector-store.js";
import type { Embedder } from "./store/surreal/embedder.js";
import { scheduleVectorBackfill, vectorBackfillState } from "./handlers/vector-backfill.js";
import {
  planningCardKindFromPath,
  parsePlanningPath,
  planningEffortId,
  planningTicketId,
} from "./store/planning-id.js";
import { planningContentHash, getStoredHash, upsertHash, deleteHash } from "./store/planning-sync-state.js";

/** Deps for the Phase B / T3 background vector backfill fired after the mirror
 *  steps. The caller (index.ts) closes over the live vectorStore/embedder/
 *  config; walkAndIngest owns the short-lived cardStore lifecycle. */
export interface VectorBackfillDeps {
  /** The HNSW vector side-table (warm-path target). */
  vectorStore: Pick<VectorStore, "getStoredHashes" | "upsertVectors">;
  /** Texts → vectors embedder (LM Studio default; injectable). */
  embedder: Embedder;
  /** Stable model-lineage tag (the delta-key component so a swap re-embeds). */
  modelVersion: string;
  /** Endpoint embedding model id passed to the embedder. */
  embedModel: string;
  /** Card kinds to embed (default: ["knowledge", "image"]). */
  kinds?: CardKind[];
}

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
  /** PLANNING-ONLY mode (Phase-2 / 09-impl T6 background backfill): skip the zk
   *  knowledge path (vault resolution + ingest + heal + vault-md mirror) so the
   *  call is truly seam-independent and bounded — planning is hermes-internal
   *  and has no zk dependency. The planning DB-mirror (step 8b: hash-compare
   *  INSERT/UPDATE/skip) + conflict-marker scan (T5) STILL run in this mode.
   *  Delete reconciliation (step 8c) does NOT run here — it is gated on
   *  `!partialWalk` (see below) because it needs the COMPLETE present-set.
   *  Default false (the knowledge-ingest tool and the normal orchestrator run
   *  the full path). */
  planningOnly?: boolean;
  /** PARTIAL WALK (09-impl final review A): the present-set of planning md is
   *  PARTIAL/BOUNDED (e.g. the T6 background backfill feeds ≤ MAX_FILES of a
   *  large corpus). When true, delete reconciliation (step 8c) is SUPPRESSED —
   *  reconcile hard-deletes every DB planning card whose id ∉ the present-set,
   *  so running it on a bounded subset would silently mass-delete out-of-window
   *  cards whose md still exists. Reconcile runs ONLY on a COMPLETE present-set
   *  (the full knowledge-ingest walk, where this opt is unset). Mirror (T3) +
   *  conflict-marker scan (T5) stay enabled in either mode. Default false. */
  partialWalk?: boolean;
  /** Opt-in LLM typed-relation extraction, threaded to zk's ingest gate as
   *  `IngestOptions.kgLlm` (whole-branch review FIX 1: MemoryConfig.kgLlm is
   *  parsed by hermes but was never carried across this seam — only the
   *  `PI_KG_LLM=1` env fallback worked). Undefined → zk's env fallback decides. */
  kgLlm?: boolean;
  /** Model override for the LLM relation extractor, threaded to zk as
   *  `IngestOptions.kgLlmModel` (mirrors kgLlm's seam). Undefined → zk's
   *  `PI_KG_LLM_MODEL` env fallback decides. */
  kgLlmModel?: string;
  /** Phase B / T3: best-effort background vector backfill fired after the mirror
   *  steps. When set, walkAndIngest schedules a delta-keyed backfill of the
   *  card_vectors HNSW index — never blocks ingest (fire-and-forget) and a throw
   *  is error-isolated. The deferred task re-checks the staleness delta and
   *  embeds only changed/new cards (unchanged cards are skipped). */
  vectorBackfill?: VectorBackfillDeps;
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
  /** # of planning-cards mirrored into the card-store (Phase-2 / 08; 0 when
   *  no .planning/ source is walked). Independent of the zk seam. */
  planningMirrored: number;
  /** Effort ids whose md carries a conflict marker (scanned in T5). Empty in
   *  T3 — the field is reserved NOW so T5 is a pure populate-change. */
  conflictMarkerEfforts: string[];
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
 *  Hermes NEVER calls runConvergenceLoop (Decision 1) and NEVER imports zk.
 *
 *  Phase-2 / 08: the knowledge block runs ONLY when the zk seam is present
 *  (`if (kp)`), but the planning DB-mirror (step 8b) runs INDEPENDENTLY —
 *  planning is hermes-internal and has no zk dependency. The walk therefore
 *  precedes the seam check so `.planning/` is classified and mirrored even
 *  with no seam (and no KNOWLEDGE_VAULT_PATH). ok:false only when there is no
 *  seam AND no planning source. */
export async function walkAndIngest(
  input: string | string[],
  opts: WalkAndIngestOptions = {},
): Promise<WalkAndIngestReceipt> {
  const folder = opts.folder ?? KNOWLEDGE_FOLDER_DEFAULT;
  const mocPath = opts.mocPath ?? KNOWLEDGE_MOC_DEFAULT;

  // 3-4. Policy walk + source-family detection (hermes owns the walk). Walked
  //  BEFORE the seam check so the planning family mirrors independent of zk.
  const walk = walkKnowledgeSources(input, opts);

  // 2. Read the seam (graceful). Planning mirror is seam-INDEPENDENT (08).
  // T6 background backfill opts out of the knowledge path entirely via
  // opts.planningOnly so a seam-present-but-vault-unset env can never throw and
  // abort the planning mirror — planning is hermes-internal (no zk dependency).
  const kp = opts.planningOnly ? undefined : getKnowledgePipeline();
  let vaultPath = "";
  let ingest: IngestSummary | undefined;
  let heal: HealReceipt | undefined;
  let mirrored = 0;
  const currentHashes: Record<string, string> = {};

  if (kp) {
    // 1. Resolve vault (env-only) — only needed for the knowledge path. Done
    //  inside `if (kp)` so a seam-absent + planning-only run never throws on a
    //  missing KNOWLEDGE_VAULT_PATH.
    vaultPath = resolveKnowledgeVaultPath();

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
    ingest = await kp.ingestRecords(records, {
      vaultPath,
      source: "workflow-jsonl",
      sourceLabel: opts.sourceLabel ?? "walkAndIngest",
      folder,
      mocPath,
      maxLinks: opts.maxLinks,
      wikiAware: opts.wikiAware,
      linkWeighting: opts.linkWeighting,
      kgLlm: opts.kgLlm,
      kgLlmModel: opts.kgLlmModel,
    });

    // 7. Heal (leaf, once). hermes decides WHEN; zk provides the primitive.
    heal = await kp.healGraph({ vaultPath, folder, mocPath });

    // 8. DB-mirror (single dedup site, Decision 4) + 9. Tier-1 drift stub.
    // Read <vaultPath>/<folder>/*.md → KnowledgeSerializer.deserialize →
    // card-store.upsertCard (knowledge kind), capturing the sha256 of each file
    // (Tier-1 md-hash hook point; no re-index action — full drift is ticket 05).
    // The store IS the 06a unified card-store — the SAME SQLite DB the memory-cards
    // use (kind-dispatched; a separate knowledge store would defeat 06a). The DB
    // dir is the existing hermes memory DB dir (`<AGENT_ROOT>/pi-hermes-memory`),
    // NEVER inside the obsidian vault. Re-mirror is idempotent via
    // KnowledgeDedupStrategy (id-upsert). Hermes READS vault-md; it does NOT write it.
    const m = await mirrorVaultMdToStore(vaultPath, folder, opts.memoryDir);
    mirrored = m.mirrored;
    Object.assign(currentHashes, m.currentHashes);
  }

  // 8b. Planning DB-mirror (Phase-2 / 09-impl) — hash-compare INSERT/UPDATE/skip.
  const planMirror = await mirrorPlanningToStore(walk.files.planning, opts.memoryDir);
  const planningMirrored = planMirror.planningMirrored;
  const conflictMarkerEfforts = planMirror.conflictMarkerEfforts; // populated in T5

  // 8c. Planning delete reconciliation (Phase-2 / 09-impl) — md-wins sweep.
  // Gated on `!partialWalk`: reconcile hard-deletes every DB planning card whose
  // id ∉ the present-set, so it MUST see a COMPLETE present-set. A bounded/
  // partial walk (T6 background backfill) feeds only a subset → suppress here to
  // avoid silently mass-deleting out-of-window cards whose md still exists
  // (09-impl final review A). Mirror (T3) + conflict-marker scan (T5) ran above
  // unconditionally and stay enabled in partial walks.
  if (!opts.partialWalk) {
    await reconcilePlanningDeletions(walk.files.planning, opts.memoryDir);
  }

  // Phase B / T3: best-effort delta-keyed vector backfill. Fire-and-forget —
  // never blocks ingest. The deferred task re-checks the staleness delta and
  // embeds only changed/new cards (unchanged cards are skipped). A throw is
  // error-isolated inside the handler (can't break ingest).
  if (opts.vectorBackfill) {
    try {
      fireVectorBackfillBestEffort(opts.memoryDir, opts.vectorBackfill);
    } catch {
      // best-effort — never break ingest
    }
  }

  // 10. Receipt.
  if (!kp && walk.files.planning.length === 0) {
    return {
      ok: false,
      vaultPath,
      folder,
      mirrored: 0,
      planningMirrored: 0,
      driftStub: { filesHashed: 0, currentHashes: {} },
      skipped: walk.skipped,
      seamPresent: false,
      reason: "zk KnowledgePipeline seam not present and no planning source",
      conflictMarkerEfforts: [],
    };
  }
  return {
    ok: true,
    vaultPath,
    folder,
    ingest,
    heal,
    mirrored,
    planningMirrored,
    conflictMarkerEfforts,
    driftStub: {
      filesHashed: Object.keys(currentHashes).length,
      previousHashes: opts.previousHashes,
      currentHashes,
    },
    skipped: walk.skipped,
    seamPresent: !!kp,
  };
}

/** Phase B / T3: fire-and-forget the delta-keyed vector backfill. Constructs a
 *  short-lived cardStore, schedules the deferred backfill against the module
 *  singleton state (so concurrent ingest runs coalesce onto one task), and
 *  closes the store after the task resolves. A throw can't escape (best-effort):
 *  ingest has already returned its receipt by the time the deferred task runs.
 *  Uses the real setTimeout (not injectable here) so the promise set by
 *  scheduleVectorBackfill is readable synchronously right after it returns. */
function fireVectorBackfillBestEffort(memoryDir: string | undefined, deps: VectorBackfillDeps): void {
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const kinds = deps.kinds ?? (["knowledge", "image"] as CardKind[]);
  void (async () => {
    let store: CardStore | null = null;
    try {
      store = await createCardStore({ memoryDir: dir });
      const scheduled = scheduleVectorBackfill(
        store,
        deps.vectorStore,
        deps.embedder,
        kinds,
        deps.modelVersion,
        deps.embedModel,
      );
      if (scheduled) {
        // The singleton promise is set synchronously by scheduleVectorBackfill;
        // chain the store close on its resolution. (Real setTimeout ⇒ the
        // deferred task has not run yet at this synchronous read.)
        const p = vectorBackfillState.promise;
        if (p) p.finally(() => { void store?.close(); }).catch(() => {});
        else await store.close();
      } else {
        // Coalesced onto an in-progress task → this store is unused; close it.
        await store.close();
      }
    } catch {
      await store?.close().catch(() => {});
    }
  })();
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

/** Mirror step 8b (Phase-2 / 09-impl): self-correcting hash-compare mirror.
 *  For each planning source: deserialize → compute incoming content-hash
 *  (planningContentHash, reusing merge-plan.hashEntry) → read the stored hash →
 *  branch:
 *    - no existing card (getCard null) → upsertCard (INSERT; dedup keep) + write hash;
 *    - stored hash ≠ incoming → updateCard (UPDATE content/frontmatter) + refresh hash;
 *    - hash match → skip (no write; cheap).
 *  Dedup is consulted ONLY for the new-card identity check (INSERT branch); the
 *  UPDATE branch bypasses dedup (pure identity cannot express update — the
 *  DedupDecision union is keep/merge/skip, by design). Returns the # of cards
 *  mirrored (INSERT+UPDATE; skips not counted) + conflict-marker efforts (T5).
 *  Independent of the zk seam (planning is hermes-internal). The store reuses the
 *  SAME SQLite DB the memory/knowledge cards use; memoryDir defaults to the
 *  existing hermes memory DB dir. No-op when planningFiles is empty. */
async function mirrorPlanningToStore(
  planningFiles: string[],
  memoryDir?: string,
): Promise<{ planningMirrored: number; conflictMarkerEfforts: string[] }> {
  const conflictMarkerEfforts: string[] = []; // populated in T5
  if (planningFiles.length === 0) return { planningMirrored: 0, conflictMarkerEfforts };
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningMirrored = 0;
  try {
    for (const abs of planningFiles) {
      const kind = planningCardKindFromPath(abs);
      if (!kind) continue;
      let bytes = "";
      try {
        bytes = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // 09-impl T5: flag efforts whose md has unresolved merge markers (human
      // review). Advisory only — the mirror STILL runs on the bytes (the markers
      // are just body text the serializer parses around). Dedup by effort slug.
      if (hasMergeConflictMarkers(bytes)) {
        const info = parsePlanningPath(abs);
        if (info && !conflictMarkerEfforts.includes(info.effort)) {
          conflictMarkerEfforts.push(info.effort);
        }
      }
      const serializer = store.serializerFor(kind);
      const cards = serializer ? serializer.deserialize(bytes, { filePath: abs }) : [];
      for (const card of cards) {
        const incomingHash = planningContentHash(card);
        const existing = await store.getCard(card.id);
        const stored = await getStoredHash(store, card.id);
        if (existing === null) {
          // Truly new card → INSERT through dedup, write hash.
          await store.upsertCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        } else if (stored === null || stored.hash !== incomingHash) {
          // 08→09 backfill (existing card, no hash yet) OR drift (md edited):
          // UPDATE content/frontmatter via updateCard (BYPASSES dedup — a pure
          // id-upsert dedup strategy would no-op an existing id and freeze the
          // row at 08-era content while the hash falsely claims "current"),
          // then refresh the hash. (09-impl final review B.)
          await store.updateCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        }
        // else: hash match → skip (no write).
      }
    }
  } finally {
    await store.close();
  }
  return { planningMirrored, conflictMarkerEfforts };
}

/** Mirror step 8c (Phase-2 / 09-impl): md-wins delete reconciliation. Given the
 *  set of planning md files PRESENT on disk, find DB planning-cards whose source
 *  md is absent → hard-delete the memories row + its card_md_hash row (Tier-1 md
 *  wins; the DB mirror must not keep rows for deleted md). Tombstoning is
 *  out-of-scope (09 hard-deletes). Returns the # of rows deleted. No-op when no
 *  planning-cards are stored. */
async function reconcilePlanningDeletions(
  presentPlanningFiles: string[],
  memoryDir?: string,
): Promise<{ planningDeleted: number }> {
  const presentIds = new Set<string>();
  for (const abs of presentPlanningFiles) {
    const info = parsePlanningPath(abs);
    if (!info) continue;
    presentIds.add(
      info.kind === "planning-effort" ? planningEffortId(info.effort) : planningTicketId(info.effort, info.ticketNo!),
    );
  }
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningDeleted = 0;
  try {
    for (const kind of ["planning-effort", "planning-ticket"] as const) {
      const rows = await store.getCardsByKind(kind);
      for (const card of rows) {
        if (!presentIds.has(card.id)) {
          await store.deleteCard(card.id);
          await deleteHash(store, card.id);
          planningDeleted++;
        }
      }
    }
  } finally {
    await store.close();
  }
  return { planningDeleted };
}
