/**
 * Dangling-reference integrity sweep (UPSP §4 — §25.9/.10 悬空检测; DO ticket 03).
 *
 * Detects memory entries whose STRUCTURED LINEAGE POINTERS reference a row that
 * no longer exists in the DB — the "evicted-target rot" left behind when
 * overflow offload / eviction deletes a target (`removeByMdId`) but the
 * surviving successor still points at the now-absent id.
 *
 * Pure + backend-neutral: takes the materialized entry list, returns the
 * dangling refs. No I/O. Wired into `syncMarkdownMemories` (the markdown→DB
 * session boundary) where its results push onto `BackfillCounters.warnings`.
 *
 * Verified mechanism: `supersedeMemory(prior, new)` sets the successor's
 * back-pointers — SQLite `UPDATE memories SET supersedes = ?, parent_ids = ?
 * WHERE id = ?` (sqlite-memory-repo.ts) — so `new.supersedes = prior` and
 * `new.parentIds = [prior]`. Overflow offload then `DELETE`s the superseded
 * prior (`removeByMdId` → `DELETE FROM memories WHERE id IN (...)`) **without
 * cleaning survivors**, so the successor's pointers dangle.
 *
 * NOTE: a pointer to a PRESENT-but-superseded row (`status === "superseded"`)
 * is normal supersession lineage — NOT flagged (it would flood). Only pointers
 * to ABSENT rows are dangling. (The ticket's "target not status=active" wording
 * is corrected here: superseded-but-present is legal lineage, not rot.)
 *
 * Body-reference parsing (the ticket's literal mechanism) is DEFERRED — live
 * memory bodies contain no inter-entry citations (verified), so a body parser
 * would be a no-op. See the effort spec for the full pivot rationale.
 */
import type { MemoryEntry, MemoryTarget } from "../store/repository.js";

/** A structured lineage field that can carry an inter-entry pointer. */
export type LineageField = "supersedes" | "supersededBy" | "parentIds";

/** One dangling lineage pointer: a survivor referencing an absent row. */
export interface DanglingReference {
  /** The referencing (surviving) entry's DB id. */
  entryId: number;
  /** The surviving entry's target bucket (memory / user / failure). */
  target: MemoryTarget;
  /** Which lineage field carried the dangling pointer. */
  field: LineageField;
  /** The absent id the field pointed at. */
  missingId: number;
}

const FIELD_RANK: Record<LineageField, number> = { supersedes: 0, supersededBy: 1, parentIds: 2 };

/**
 * Find lineage pointers to rows absent from `entries`.
 *
 * @param entries  Every memory row (typically `await memoryRepo.getMemories()`).
 * @param freshIds DB ids created THIS round — excluded from checks, since a
 *                 just-born successor may transiently point at a target not yet
 *                 imported. Defaults empty: at the `syncMarkdownMemories` seam,
 *                 imports never set lineage pointers (only `supersedeMemory`
 *                 does), so fresh exclusion is automatically satisfied there.
 * @returns Dangling references, sorted deterministically
 *          (entryId → field → missingId) for stable warning output.
 */
export function findDanglingLineageReferences(
  entries: readonly MemoryEntry[],
  freshIds: ReadonlySet<number> = new Set(),
): DanglingReference[] {
  const present = new Set<number>(entries.map((e) => e.id));
  const out: DanglingReference[] = [];

  for (const e of entries) {
    // Fresh-this-round entries are skipped wholesale — a brand-new successor
    // pointing at a not-yet-imported prior is legal, not rot.
    if (freshIds.has(e.id)) continue;

    if (typeof e.supersedes === "number" && !present.has(e.supersedes)) {
      out.push({ entryId: e.id, target: e.target, field: "supersedes", missingId: e.supersedes });
    }
    if (typeof e.supersededBy === "number" && !present.has(e.supersededBy)) {
      out.push({ entryId: e.id, target: e.target, field: "supersededBy", missingId: e.supersededBy });
    }
    if (Array.isArray(e.parentIds)) {
      // De-dup parentIds defensively — a malformed [5, 5] should flag id 5 once.
      const seen = new Set<number>();
      for (const pid of e.parentIds) {
        if (typeof pid === "number" && !present.has(pid) && !seen.has(pid)) {
          seen.add(pid);
          out.push({ entryId: e.id, target: e.target, field: "parentIds", missingId: pid });
        }
      }
    }
  }

  out.sort(
    (a, b) =>
      a.entryId - b.entryId ||
      FIELD_RANK[a.field] - FIELD_RANK[b.field] ||
      a.missingId - b.missingId,
  );
  return out;
}

/** Format a single dangling reference as a stable warning line. */
export function formatDanglingWarning(d: DanglingReference): string {
  return `dangling ${d.field}: ${d.target}#${d.entryId} → missing id ${d.missingId}`;
}
