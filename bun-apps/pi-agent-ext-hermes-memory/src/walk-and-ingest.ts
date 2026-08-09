import { readFileSync } from "node:fs";
import type { IngestSummary, HealReceipt, LinkWeighting } from "@repo/pi-agent-ext-core-interface";
import { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";
import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT, KNOWLEDGE_MOC_DEFAULT } from "./knowledge-vault-path.js";
import { walkKnowledgeSources, type WalkOptions } from "./knowledge-walk.js";
import { parseKnowledgeJsonl } from "./knowledge-jsonl.js";

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
  /** Tier-1 md-hash drift hook stub (task 7; {filesHashed:0} here). */
  driftStub: { filesHashed: number };
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
      driftStub: { filesHashed: 0 },
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

  // 8 (DB-mirror) + 9 (drift stub) land in tasks 5/7. Placeholders for now.

  // 10. Receipt.
  return {
    ok: true,
    vaultPath,
    folder,
    ingest,
    heal,
    mirrored: 0,
    driftStub: { filesHashed: 0 },
    skipped: walk.skipped,
    seamPresent: true,
  };
}
