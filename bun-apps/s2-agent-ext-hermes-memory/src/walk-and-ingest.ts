import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IngestSummary, HealReceipt, LinkWeighting } from "@repo/s2-agent-core-interface";
import { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";
import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT, KNOWLEDGE_MOC_DEFAULT } from "./knowledge-vault-path.js";
import { walkKnowledgeSources, type WalkOptions } from "./knowledge-walk.js";
import { parseKnowledgeJsonl } from "./knowledge-jsonl.js";
import { hasMergeConflictMarkers } from "./git-ops.js";
import { AGENT_ROOT } from "./paths.js";
import { MEMORY_FILE, USER_FILE } from "./constants.js";
import { splitMemoryEntries } from "./merge-union.js";
import { parseMarkdownMemoryEntry } from "./store/memory-format.js";
import { mirrorMemoryEntry, type MemoryCardKind } from "./store/memory-card-mirror.js";
import { createCardStore, type CardStore } from "./store/card-store.js";
import type { Card } from "./store/card.js";
import { fireHierarchyBuildBestEffort, type HierarchyDeps } from "./handlers/hierarchy-build.js";
import {
  planningCardKindFromPath,
  parsePlanningPath,
  planningEffortId,
  planningTicketId,
} from "./store/planning-id.js";
import { planningContentHash, getStoredHash, upsertHash, deleteHash } from "./store/planning-sync-state.js";

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
  /** kg.llm extractor model override — call-opts layer; config-file value is
   *  seeded here by the composition site, env fallback PI_KG_LLM_MODEL stays
   *  terminal in zk. */
  kgLlmModel?: string;
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
  /** LeanRAG ① / ticket 04b-2: fire-and-forget multi-layer hierarchy build
   *  fired after the mirror steps. Injected callables (D4); skips silently
   *  when embeds are unavailable. */
  hierarchy?: HierarchyDeps;
  /** kp21 Tier-3: frontmatter fields where the DB row is authoritative
   *  (opt-in; default empty = md-canonical). For each listed field, the
   *  vault-md mirror copies the stored card's value over the md-deserialized
   *  value BEFORE hashing/writing, so the DB value survives re-walks. */
  dbAuthoritativeFields?: readonly string[];
  /** kp21 Tier-3: write DB-authoritative values back into the md file when
   *  they differ (default false — decision 05: no md write-through). */
  dbAuthoritativeWriteBack?: boolean;
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
  /** # of memory §-entries re-indexed into the card-store (kp13 Wave C /
   *  ticket 13 — Tier-1 md-wins mirror of the GLOBAL MEMORY.md / USER.md /
   *  failures.md; counts INSERT+UPDATE, skips excluded). Independent of the
   *  zk seam and of the walked input (fixed memory-dir location). */
  memoryMirrored: number;
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
    /** kp21 Tier-1 drift: # of cards INSERTed (existing===null) or UPDATEd
     *  (stored hash missing or ≠ incoming) by the vault-md mirror. */
    changed: number;
    /** kp21 Tier-1 drift: # of cards skipped (stored hash === incoming). */
    unchanged: number;
    /** kp21 Tier-1 drift: # of md-wins sweep deletions (kind='vault-md' hash
     *  rows whose cardId is absent from the walked present-set). */
    removed: number;
    /** kp21: the store lacks the card_md_hash capability (SQLITE_ONLY seam
     *  throw on the side-effect-free probe) → legacy unconditional-upsert
     *  fallback, zero drift counts. */
    driftDisabled?: boolean;
  };
  /** kp21 Tier-3: DB-authoritative frontmatter merge counts. `merged` = # of
   *  dbAuthoritativeFields values copied from the DB row over the md card;
   *  `writtenBack` = # of those also spliced back into the md file
   *  (dbAuthoritativeWriteBack). Always populated; zeros when the feature is
   *  off or drift is disabled. */
  dbAuthoritative: { merged: number; writtenBack: number };
  skipped: { dirs: string[]; binaries: string[]; symlinks: string[]; deferredFamily: string[] };
  seamPresent: boolean;
  /** Set when ok:false (graceful degradation reason). */
  reason?: string;
}

/** On-demand orchestrator (06b): resolve vault → read seam (graceful) → policy
 *  walk → family detect → adapt workflow-jsonl → kp.ingestRecords (zk writes
 *  vault-md) → kp.healGraph once → receipt. The DB-mirror (step 8) + drift stub
 *  (step 9) land in tasks 5/7. generic family is detected-but-deferred (Option A).
 *  Hermes NEVER calls the convergence loop (retired L1; Decision 1) and NEVER imports zk.
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
  // kp21 Tier-1 drift counters (vault-md mirror): changed = INSERT/UPDATE
  // arms, unchanged = hash-match skips, removed = md-wins sweep deletions.
  let driftChanged = 0;
  let driftUnchanged = 0;
  let driftRemoved = 0;
  let driftDisabled: boolean | undefined;
  // kp21 Tier-3 DB-authoritative merge counters (vault-md mirror).
  let dbAuthMerged = 0;
  let dbAuthWrittenBack = 0;
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
    const m = await mirrorVaultMdToStore(vaultPath, folder, opts.memoryDir, {
      fields: opts.dbAuthoritativeFields,
      writeBack: opts.dbAuthoritativeWriteBack,
    });
    mirrored = m.mirrored;
    driftChanged = m.changed;
    driftUnchanged = m.unchanged;
    driftRemoved = m.removed;
    driftDisabled = m.driftDisabled;
    dbAuthMerged = m.dbAuthoritative.merged;
    dbAuthWrittenBack = m.dbAuthoritative.writtenBack;
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

  // 8d. Memory DB-mirror (kp13 Wave C / ticket 13) — Tier-1 md-wins re-index of
  // the GLOBAL memory md. Runs UNCONDITIONALLY (like the planning mirror): the
  // 3 files live at a FIXED known location (the memory dir — NOT inside any
  // walked input), so this needs no walk classification and no zk seam; it also
  // runs in planningOnly mode, which makes the session-start planning backfill
  // the Tier-1 re-index trigger for direct md edits. Idempotent (identity-
  // compare skip on unchanged entries).
  const memoryMirrored = await mirrorMemoryToStore(opts.memoryDir);

  // LeanRAG ① / ticket 04b-2: best-effort hierarchy build. Fire-and-forget,
  // never awaited, error-isolated inside the handler (catch-all console.warn).
  // kbDir = <vaultPath>/<folder>; unset vaultPath (no seam / no vault) →
  // undefined → silent skip. The heal target rides along so the build's agg
  // cards are folded into the MOC immediately (the step-7 heal above runs
  // BEFORE this fire — without a post-build heal the MOC went stale on every
  // build until a later ingest caught it up; 2026-08-30 t14 receipt finding).
  if (opts.hierarchy) {
    try {
      fireHierarchyBuildBestEffort(
        vaultPath ? join(vaultPath, folder) : undefined,
        opts.hierarchy,
        vaultPath ? { vaultPath, folder, mocPath } : undefined,
      );
    } catch {
      // best-effort — never break ingest
    }
  }

  // 10. Receipt.
  if (!kp && walk.files.planning.length === 0) {
    // No zk seam AND no planning source. The memory mirror (8d) still ran —
    // its count is reported truthfully; ok:false describes the walk's INPUT
    // families (seam + planning), not the memory side-step.
    return {
      ok: false,
      vaultPath,
      folder,
      mirrored: 0,
      planningMirrored: 0,
      memoryMirrored,
      driftStub: { filesHashed: 0, currentHashes: {}, changed: 0, unchanged: 0, removed: 0 },
      dbAuthoritative: { merged: 0, writtenBack: 0 },
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
    memoryMirrored,
    conflictMarkerEfforts,
    driftStub: {
      filesHashed: Object.keys(currentHashes).length,
      previousHashes: opts.previousHashes,
      currentHashes,
      changed: driftChanged,
      unchanged: driftUnchanged,
      removed: driftRemoved,
      ...(driftDisabled ? { driftDisabled: true } : {}),
    },
    dbAuthoritative: { merged: dbAuthMerged, writtenBack: dbAuthWrittenBack },
    skipped: walk.skipped,
    seamPresent: !!kp,
  };
}

/** Mirror step 8 (Decision 4) + Tier-1 drift (kp21): read
 *  `<vaultPath>/<folder>/*.md` → deserialize via the store's knowledge serializer
 *  (the 06a registry) → hash-compare mirror into the card-store, AND capture the
 *  sha256 of each file's bytes (`relPath → hash`) as the Tier-1 md-hash hook
 *  point. The store reuses the SAME SQLite DB the memory-cards use
 *  (`<memoryDir>/sessions.db`); `memoryDir` defaults to the existing hermes
 *  memory DB dir, NEVER inside the vault.
 *
 *  Capability guard (kp21): the card_md_hash accessors are SQLITE_ONLY on the
 *  CardPersistence seam, so BEFORE any card write the mirror probes the store
 *  with a side-effect-free getCardMdHash (probe id = the first deserialized
 *  card's id, or the synthetic `__kp21_capability_probe__` when the vault
 *  yielded no cards — a read that returns null on sqlite and throws on a
 *  card_md_hash-less backend). Throw ⇒ driftDisabled: run the legacy
 *  unconditional per-card upsertCard loop verbatim (no hash rows, no sweep) and
 *  report zeroed drift counts.
 *
 *  Tier-1 arms (drift-capable store; same shape as mirrorPlanningToStore): no
 *  existing card → upsertCard (INSERT; dedup keep) + hash row; existing card
 *  with missing/≠ hash → updateCard (UPDATE — NOT upsertCard: a pure id-skip
 *  dedup strategy would no-op an existing id and freeze the row at stale
 *  content while the hash falsely claims "current"; 09-impl review B) +
 *  refresh hash; hash match → skip (no write). `mirrored` counts EVERY arm
 *  including skips (pre-existing contract: re-walking an unchanged corpus
 *  yields the same mirrored count). md-wins sweep: kind='vault-md' card_md_hash
 *  rows whose cardId is absent from the walked present-set are hard-deleted
 *  (card + hash row) — the vault md was removed, so the store follows.
 *  card_md_hash keys card_id-only with NO source-path column, but vault-md
 *  knowledge ids (e.g. "r1") and planning ids (planning-effort:*,
 *  planning-ticket:*) are disjoint id spaces AND the sweep filters
 *  kind='vault-md', so planning mirror rows are never touched.
 *
 *  kp21 Tier-3 (dbAuthoritativeFields / dbAuthoritativeWriteBack): for each
 *  opted-in field, the DB row's frontmatter value wins over the md value —
 *  merged into the card BEFORE planningContentHash (so the stored hash
 *  reflects the merged row) — and, when write-back is on, spliced back into
 *  the md file via spliceFrontmatterField. Default off = md-canonical. */
async function mirrorVaultMdToStore(
  vaultPath: string,
  folder: string,
  memoryDir?: string,
  dbAuth?: { fields?: readonly string[]; writeBack?: boolean },
): Promise<{
  mirrored: number;
  currentHashes: Record<string, string>;
  changed: number;
  unchanged: number;
  removed: number;
  driftDisabled?: boolean;
  dbAuthoritative: { merged: number; writtenBack: number };
}> {
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const dbFields = dbAuth?.fields ?? [];
  const dbWriteBack = dbAuth?.writeBack === true;
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
      return { mirrored: 0, currentHashes, changed: 0, unchanged: 0, removed: 0, dbAuthoritative: { merged: 0, writtenBack: 0 } };
    }
    // Pass 1 — read + hash + deserialize everything BEFORE any card write, so
    // the capability probe below uses a real first-card id and no partial state
    // is written when the backend turns out to lack card_md_hash.
    const cards: Array<{ card: Card; relPath: string }> = [];
    // kp21 Tier-3: raw utf8 text per relPath — the write-back splices DB-
    // authoritative values into this text and re-writes the md file in place.
    const rawByRel = new Map<string, string>();
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
      rawByRel.set(relPath, bytes);
      currentHashes[relPath] = createHash("sha256").update(bytes).digest("hex");
      // KnowledgeSerializer.deserialize tolerates a non-zettel/partial file → []
      // (defensive; never throws on one malformed vault file).
      const deserialized = serializer ? serializer.deserialize(bytes, { filePath: relPath }) : [];
      for (const card of deserialized) cards.push({ card, relPath });
    }
    // kp21 capability probe (side-effect-free read): a real card id when the
    // vault yielded cards, else the synthetic id — sqlite returns null, a
    // card_md_hash-less backend throws ⇒ legacy unconditional-upsert fallback.
    let driftOk: boolean | null = null;
    const probeId = cards.length > 0 ? cards[0].card.id : "__kp21_capability_probe__";
    try {
      await store.getCardMdHash(probeId);
      driftOk = true;
    } catch {
      driftOk = false;
    }
    if (driftOk !== true) {
      // Legacy fallback (pre-kp21 behavior, verbatim): unconditional id-upsert
      // per card, no hash rows, no sweep, zeroed drift counts (Tier-3 zeros
      // too — merge needs the drift-capable path's hash-consistent rows).
      for (const { card } of cards) {
        await store.upsertCard(card);
        mirrored++;
      }
      return {
        mirrored,
        currentHashes,
        changed: 0,
        unchanged: 0,
        removed: 0,
        driftDisabled: true,
        dbAuthoritative: { merged: 0, writtenBack: 0 },
      };
    }
    let changed = 0;
    let unchanged = 0;
    let removed = 0;
    let dbMerged = 0;
    let dbWrittenBack = 0;
    const present = new Set<string>();
    for (const { card, relPath } of cards) {
      const existing = await store.getCard(card.id);
      // kp21 Tier-3: DB-authoritative frontmatter merge. Runs BEFORE
      // planningContentHash so the incoming hash reflects the MERGED card
      // (otherwise the hash would claim drift on every re-walk). md value is
      // left untouched unless dbAuthoritativeWriteBack splices the DB value
      // back into the md file (decision 05 opt-in).
      let mergedFields = 0;
      let writeBackDone = 0;
      if (dbFields.length > 0) {
        const dbFm = existing?.frontmatter as unknown as Record<string, unknown> | undefined;
        const mdFm = card.frontmatter as unknown as Record<string, unknown> | undefined;
        for (const f of dbFields) {
          const dbVal = dbFm?.[f];
          if (dbVal === undefined) continue;
          if (JSON.stringify(dbVal) === JSON.stringify(mdFm?.[f])) continue;
          if (!card.frontmatter) card.frontmatter = {} as typeof card.frontmatter;
          (card.frontmatter as unknown as Record<string, unknown>)[f] = dbVal;
          mergedFields++;
          if (dbWriteBack) {
            const raw = rawByRel.get(relPath);
            if (raw !== undefined) {
              const spliced = spliceFrontmatterField(raw, f, dbVal);
              if (spliced !== null) {
                writeFileSync(join(vaultPath, relPath), spliced, "utf8");
                rawByRel.set(relPath, spliced);
                writeBackDone++;
              }
            }
          }
        }
      }
      dbMerged += mergedFields;
      dbWrittenBack += writeBackDone;
      const incoming = planningContentHash(card);
      const stored = await getStoredHash(store, card.id);
      if (existing === null) {
        // Truly new card → INSERT through dedup, write hash row.
        await store.upsertCard(card);
        await upsertHash(store, card.id, incoming, "vault-md");
        changed++;
      } else if (stored === null || stored.hash !== incoming) {
        // Drift (vault md edited) or pre-hash backfill (card exists, no hash
        // row yet): UPDATE via updateCard (bypasses the id-skip dedup no-op)
        // and refresh the hash row.
        await store.updateCard(card);
        await upsertHash(store, card.id, incoming, "vault-md");
        changed++;
      } else {
        // Hash match → skip the write (cheap idempotent re-walk).
        unchanged++;
      }
      mirrored++; // count ALL arms, including skips (count-all contract).
      present.add(card.id);
    }
    // kp21 md-wins sweep: kind='vault-md' hash rows whose card id was NOT in
    // the walked vault → the md was deleted; the store follows (card + hash
    // row). Disjoint from planning rows: knowledge ids vs planning-* ids are
    // disjoint id spaces and the sweep filters kind='vault-md'.
    const rows = await store.listCardMdHashes("vault-md");
    for (const row of rows) {
      if (!present.has(row.cardId)) {
        await store.deleteCard(row.cardId);
        await store.deleteCardMdHash(row.cardId);
        removed++;
      }
    }
    return { mirrored, currentHashes, changed, unchanged, removed, dbAuthoritative: { merged: dbMerged, writtenBack: dbWrittenBack } };
  } finally {
    await store.close();
  }
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

/** Mirror step 8d (kp13 Wave C / ticket 13): Tier-1 md-wins re-index of the
 *  GLOBAL memory md into the card-store. For each of MEMORY.md (kind memory),
 *  USER.md (kind user), failures.md (kind failure) in the memory dir: split
 *  §-entries → parseMarkdownMemoryEntry (the SAME parse the sync-markdown
 *  startup pass uses) → mirrorMemoryEntry (the shared md_id-keyed identity-
 *  compare primitive): no card for the id → INSERT through the registered
 *  MemoryDedupStrategy; content OR envelope drifted (the md was edited
 *  directly — md wins) → updateCard (UPDATE in place, id stable); identical →
 *  skip. Entries without a stable id (comment-shape, pre-5d) are no-ops —
 *  they mirror once the 5d backfill upgrades them (lazy, same as startup).
 *
 *  Hash-compare mechanism (deliberate divergence from the planning mirror):
 *  an IN-MEMORY identity compare — getCard + content/frontmatter equality —
 *  NOT planning's `card_md_hash` rows: those accessors are SQLITE_ONLY on the
 *  CardPersistence seam (Wave A decision), so a hash-row-based memory mirror
 *  would break the moment the mirror runs against a surreal-backed store. The
 *  identity compare calls only dual-backend methods (getCard/upsertCard/
 *  updateCard) and behaves identically on sqlite and surreal. The walk itself
 *  opens the same short-lived sqlite-backed store the planning/knowledge
 *  mirrors use (createCardStore({memoryDir})); the primitive is backend-
 *  agnostic if a future caller passes the bundle store.
 *
 *  Scope (ticket 13 / plan 13-three-waves.md Wave C):
 *  - GLOBAL files only. In-repo project memory (`.agents/memory/MEMORY.md`)
 *    stays walk-deferred (walkKnowledgeSources deferredFamily) — its Tier-1
 *    walk re-index is ticket 21. The startup pass covers it via
 *    inRepoProjectFile today.
 *  - NO delete reconciliation here: md removals flow through the writer-path
 *    remove/eviction mirrors (mirrorMemoryRemove / mirrorMemoryEvictions).
 *    Tier-2 derived-cache is ticket 21; Tier-3 implemented
 *    (dbAuthoritativeFields/dbAuthoritativeWriteBack).
 *  - Gating: UNCONDITIONAL like the planning mirror (fixed location, ≤3 files,
 *  idempotent, no VLM/cost concern — unlike images' opt-in includeImages).
 *  Absent files (nothing written yet) are no-ops. Returns the # of entries
 *  INSERTed or UPDATEd (skips excluded). */
const MEMORY_MIRROR_FILES: ReadonlyArray<{ file: string; kind: MemoryCardKind }> = [
  { file: MEMORY_FILE, kind: "memory" },
  { file: USER_FILE, kind: "user" },
  { file: "failures.md", kind: "failure" },
];

async function mirrorMemoryToStore(memoryDir?: string): Promise<number> {
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let memoryMirrored = 0;
  try {
    for (const { file, kind } of MEMORY_MIRROR_FILES) {
      let bytes = "";
      try {
        bytes = readFileSync(join(dir, file), "utf8");
      } catch {
        continue; // file absent (nothing written yet) → no-op for this kind
      }
      for (const rawEntry of splitMemoryEntries(bytes)) {
        const parsed = parseMarkdownMemoryEntry(rawEntry, kind, null);
        const outcome = await mirrorMemoryEntry(store, kind, {
          mdId: parsed.mdId,
          content: parsed.content,
          created: parsed.created ?? null,
          last: parsed.lastReferenced ?? null,
          ...(parsed.state ? { state: parsed.state } : {}),
          ...(typeof parsed.severity === "number" ? { severity: parsed.severity } : {}),
          ...(parsed.pin === true ? { pin: true } : {}),
        });
        if (outcome === "inserted" || outcome === "updated") memoryMirrored++;
      }
    }
  } finally {
    await store.close();
  }
  return memoryMirrored;
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

/** kp21 Tier-3: render a scalar frontmatter value as a YAML scalar string.
 *  Strings stay plain unless they contain `:`/`#`, carry leading/trailing
 *  whitespace, or are empty — then single-quoted with `''` escaping. Numbers /
 *  booleans render via String(); null (and undefined, defensive) render as
 *  `null`; plain objects / arrays render as JSON. */
function renderYamlScalar(value: unknown): string {
  if (typeof value === "string") {
    if (value === "" || /[:#]/.test(value) || value.trim() !== value) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** kp21 Tier-3: splice `field: <scalar>` into the leading YAML frontmatter of
 *  an md file's raw text. Frontmatter = a leading `---` line through the next
 *  `---` line. An existing top-level `field:` line inside the block is
 *  replaced in place; otherwise the field is inserted immediately before the
 *  closing `---`. No frontmatter block → null (caller skips the write-back). */
function spliceFrontmatterField(raw: string, field: string, value: unknown): string | null {
  const lines = raw.split("\n");
  if (lines[0]?.trimEnd() !== "---") return null;
  const closeIdx = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (closeIdx === -1) return null;
  const rendered = `${field}: ${renderYamlScalar(value)}`;
  for (let i = 1; i < closeIdx; i++) {
    if (lines[i]!.startsWith(`${field}:`)) {
      lines[i] = rendered;
      return lines.join("\n");
    }
  }
  lines.splice(closeIdx, 0, rendered);
  return lines.join("\n");
}
