/**
 * memory_supersede execute — agent-driven supersession.
 *
 * Retire a stale/wrong memory by creating a linked replacement. The prior is
 * flipped to `status='superseded'` (hidden from default search via the Task 3/4
 * status filter); the replacement carries lineage (`supersedes`/`parentIds`)
 * back to it.
 *
 * CRITICAL SEAM: the replacement's DB id is captured by resolving the
 * mirrored row via its md_id (the `.md` frontmatter id threaded from
 * `store.add`'s `added_md_id`). kp13 Wave B: the replacement is mirrored
 * through the bundle CardStore (md_id-keyed upsert, dedup rides the
 * registered MemoryDedupStrategy); the numeric row id for lineage is then
 * resolved from the repo by md_id (content match as fallback when dedup
 * skipped the insert because an identical row already exists).
 *
 * Flow:
 *   1. `store.add`          — write the replacement to Markdown (.md is the
 *                             source of truth; the .md layer has no lineage).
 *   2. cardStore mirror     — upsert the md_id-keyed replacement card.
 *   2b. row-id resolve      — find the mirrored row's numeric id (md_id match,
 *                             content fallback) for lineage.
 *   3. `supersedeMemory`    — flip prior→superseded + stamp new→supersedes.
 *   4. probe (`searchMemories`) — best-effort verification that the replacement
 *                             is searchable and the prior is hidden.
 *
 * Partial-failure mode: if step 3 throws AFTER step 2 succeeded, the
 * replacement is persisted (both .md and DB) but lineage is unlinked. This is
 * RECOVERABLE — the agent can retry `memory_supersede` with the same
 * prior_id/replacement (the card-store upsert dedups on content, so the
 * retry reuses the same row). We report `linked:false` + a retry hint and
 * never fail the whole tool.
 */
import type { MemoryRepository, MemoryTarget } from "../store/repository.js";
import type { CardStore } from "../store/card-store.js";
import { mirrorMemoryAdd } from "../store/memory-card-mirror.js";
import type { MemoryStore } from "../store/memory-store.js";
import type { MemorySource } from "../types.js";

/** Parameters for executeMemorySupersede (was the memory_supersede tool schema). */
export interface MemorySupersedeParams {
  /** The DB id of the memory to retire (from a memory_search result). */
  prior_id: number;
  /** The corrected memory content (becomes a new active entry). */
  replacement: string;
  /** Which memory home the replacement belongs in (defaults alongside the prior). */
  target: MemoryTarget;
  /** Optional grounding sources attached to the replacement (.md-resident only). */
  sources?: MemorySource[];
}

export async function executeMemorySupersede(
  memoryRepo: MemoryRepository | null,
  store: MemoryStore,
  projectName: string | null | undefined,
  cardStore: CardStore | null,
  params: MemorySupersedeParams,
): Promise<string> {
  const { prior_id, replacement, target, sources } = params;

  // The .md layer has no project concept at the store.add level (project
  // scoping lives in separate projectStores upstream); the replacement
  // always lands in the global MEMORY/USER/FAILURE.md here. The search
  // store gets the explicit project below.
  const addRes = await store.add(target, replacement, sources && sources.length > 0 ? { sources } : {});
  if (!addRes.success) {
    return `Supersede failed: replacement was not saved — ${addRes.error ?? "add failed"}.`;
  }

  // No search store → nothing to link or verify. The .md write already
  // succeeded, so this is a soft success (ok:true, linked:false).
  if (!memoryRepo) {
    return "Replacement saved to Markdown, but no search store is configured — lineage could not be linked.";
  }

  try {
    // The `target` is already memory/user/failure (no "project"
    // variant), so the sqlite-target mapping is identity here. Project
    // defaults to null (global) when the caller omits it — matching
    // the memory/user/failure convention in sqliteProjectFor.
    const sqliteTarget: MemoryTarget = target;
    const sqliteProject = projectName ?? null;

    // Step 2 (kp13 Wave B): mirror the replacement through the card-store
    // (md_id-keyed upsert; dedup rides upsertCard's registered
    // MemoryDedupStrategy). Task 7 / F1: thread the birth id
    // (addRes.added_md_id) so the card id == the `.md` frontmatter id.
    await mirrorMemoryAdd(cardStore, target, {
      mdId: addRes.added_md_id,
      content: replacement,
    });

    // Step 2b: resolve the mirrored row's NUMERIC id (supersedeMemory +
    // searchMemories key on row ids) — md_id match first, exact-content
    // fallback for the dedup-skipped case (an identical row already
    // existed and kept its own id).
    const rows = await memoryRepo.getMemories({ target: sqliteTarget, project: sqliteProject });
    const mdIdHit = addRes.added_md_id
      ? rows.find((m) => m.mdId === addRes.added_md_id)
      : undefined;
    const row = mdIdHit ?? rows.find((m) => m.content === replacement);
    if (!row) {
      throw new Error("replacement row not resolvable in the search store after the card-store mirror");
    }
    const newId = row.id;

    // Step 3: flip lineage. Best-effort — a throw here is recoverable
    // (caught below) since the replacement is already persisted.
    await memoryRepo.supersedeMemory(prior_id, newId);

    // Step 4: best-effort verification probe. Search a 3-word slice of the
    // replacement as a lexical handle. searchMemories hides superseded
    // entries by default (Task 3/4 status filter), so priorAbsent is the
    // filter doing its job — NOT lexical luck. Never fail the tool if the
    // probe throws; degrade to probe:undefined.
    let probe: { replacementPresent: boolean; priorAbsent: boolean } | undefined;
    try {
      const handle = replacement
        .split(/\s+/)
        .slice(0, 3)
        .join(" ")
        .trim();
      const hits =
        handle.length > 0
          ? await memoryRepo.searchMemories(handle, {
              target: sqliteTarget,
              project: sqliteProject,
            })
          : [];
      probe = {
        replacementPresent: hits.some((h) => h.id === newId),
        priorAbsent: !hits.some((h) => h.id === prior_id),
      };
    } catch {
      probe = undefined;
    }

    const probeText = probe
      ? ` Probe: replacement ${probe.replacementPresent ? "present" : "MISSING"}, prior ${probe.priorAbsent ? "hidden" : "LEAKED"}.`
      : " Probe skipped (search unavailable).";

    return `Superseded memory #${prior_id} with #${newId}.${probeText}`;
  } catch (err) {
    // Replacement saved to BOTH .md and the search store, but lineage link
    // failed. Recoverable: retry memory_supersede (the card-store upsert
    // dedups on content, so the retry reuses the same row).
    const reason = err instanceof Error ? err.message : String(err);
    return `Replacement saved to Markdown and the search store, but lineage link failed: ${reason}. (Recoverable — retry memory_supersede.)`;
  }
}
