/**
 * MergePlan — consolidation merge plan types, entry hashing, and schema.
 *
 * A {@link MergePlan} describes how a {@link ConsolidationSnapshot} should be
 * rewritten once it has exceeded its char budget: entries are either dropped or
 * merged into new content. The plan is produced by an LLM (via
 * `structured_output` constrained by {@link mergePlanSchema}) and validated at
 * runtime by {@link mergePlanValidate} before it is applied.
 */

import { createHash } from "node:crypto";

import { ENTRY_DELIMITER } from "../constants.js";
import { serializeMetadataComment, today, decodeMemoryEntry } from "./memory-format.js";

/** 16-hex-char sha256 digest of an encoded entry. */
export type EntryHash = string;

/** A single entry as captured in a consolidation snapshot. */
export type SnapshotEntry = {
  key: EntryHash;
  content: string;
  created: string;
  last: string;
  /** Stable frontmatter id (the md_id mirrored onto the DB row), surfaced so
   *  buildSnapshot's optional heat-sort can key into the per-entry heat Map.
   *  Present only for YAML-frontmatter entries (`parseMetadataFrontmatter().id`);
   *  legacy comment-shape entries carry no id → `undefined` (heat-sort places
   *  them at {@link NEUTRAL_HEAT}). `key` stays the hash of the *raw* encoded
   *  string (shape-agnostic), so drop ops still match across a mixed-shape set. */
  mdId?: string;
};

/** Full snapshot of the entries targeted for consolidation. */
export type ConsolidationSnapshot = {
  target: "memory" | "user" | "failure";
  entries: SnapshotEntry[];
  totalChars: number;
  charLimit: number;
  snapshotBaseHash: string;
};

/** A single rewrite operation within a {@link MergePlan}. */
export type MergePlanOp =
  | { op: "drop"; key: EntryHash; reason?: string }
  | { op: "merge"; fromKeys: EntryHash[]; content: string; reason?: string };

/** A plan to rewrite a consolidation snapshot back under its char budget. */
export type MergePlan = { snapshotBaseHash: string; ops: MergePlanOp[] };

/**
 * sha256 digest of an encoded entry, truncated to 16 hex chars.
 *
 * Deterministic and content-sensitive: identical inputs always hash identically
 * and any change to the input changes the digest.
 */
export function hashEntry(encoded: string): EntryHash {
  return createHash("sha256").update(encoded, "utf8").digest("hex").slice(0, 16);
}

/**
 * Order-insensitive base hash for a set of encoded entries.
 *
 * Computed from the sorted 16-char entry hashes joined by `|`, so reordering
 * the entries (or the snapshot) yields the same value, while adding/removing or
 * editing an entry changes it.
 */
export function snapshotBaseHash(encodedEntries: string[]): string {
  const joined = encodedEntries.map(hashEntry).sort().join("|");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/**
 * JSON Schema describing {@link MergePlan}.
 *
 * Used as the `structured_output` schema for the LLM that proposes a plan, and
 * as the structural backbone for {@link mergePlanValidate}. Note: structural
 * optionality aside, a valid plan additionally requires non-empty `key` (drop)
 * and non-empty `content` + `fromKeys` (merge) — those semantic constraints are
 * enforced by {@link mergePlanValidate} rather than by this schema.
 */
export const mergePlanSchema = {
  type: "object",
  required: ["snapshotBaseHash", "ops"],
  properties: {
    snapshotBaseHash: { type: "string" },
    ops: {
      type: "array",
      items: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["drop", "merge"] },
          key: { type: "string" },
          fromKeys: { type: "array", items: { type: "string" } },
          content: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Validate `plan` against {@link mergePlanSchema} plus the semantic constraints.
 *
 * Throws on any structural or semantic violation. Structural checks mirror
 * {@link mergePlanSchema}; the semantic rules are:
 * - a `"drop"` op requires a non-empty `key`;
 * - a `"merge"` op requires non-empty `content` and non-empty `fromKeys`.
 */
export function mergePlanValidate(plan: unknown): asserts plan is MergePlan {
  if (plan === null || typeof plan !== "object") {
    throw new Error("mergePlanValidate: plan must be an object");
  }
  const p = plan as Record<string, unknown>;
  if (typeof p.snapshotBaseHash !== "string") {
    throw new Error("mergePlanValidate: snapshotBaseHash must be a string");
  }
  if (!Array.isArray(p.ops)) {
    throw new Error("mergePlanValidate: ops must be an array");
  }

  for (let i = 0; i < p.ops.length; i++) {
    const op = p.ops[i];
    if (op === null || typeof op !== "object") {
      throw new Error(`mergePlanValidate: ops[${i}] must be an object`);
    }
    const o = op as Record<string, unknown>;
    if (o.op === "drop") {
      if (typeof o.key !== "string" || o.key.length === 0) {
        throw new Error(`mergePlanValidate: ops[${i}] drop requires non-empty key`);
      }
    } else if (o.op === "merge") {
      if (!Array.isArray(o.fromKeys) || o.fromKeys.length === 0) {
        throw new Error(`mergePlanValidate: ops[${i}] merge requires non-empty fromKeys`);
      }
      if (typeof o.content !== "string" || o.content.length === 0) {
        throw new Error(`mergePlanValidate: ops[${i}] merge requires non-empty content`);
      }
    } else {
      throw new Error(`mergePlanValidate: ops[${i}] has invalid or missing op`);
    }
  }
}

// ─── Snapshot builder + reconcile applier ─────────────────────────────────
//
// These pure functions turn a flat list of encoded memory entries into a
// {@link ConsolidationSnapshot} and then rewrite live entries according to a
// {@link MergePlan}. They are intentionally free of any store/IO coupling so
// they can be unit-tested in isolation and reused by whichever caller drives
// a consolidation pass.
//
// Entry (de)coding is delegated to the existing free helpers in
// `memory-format.ts` (`parseMetadataComment` / `serializeMetadataComment`),
// which are already the single source of truth that the store class methods
// delegate to — so no codec is duplicated here.

/**
 * Neutral heat placement for snapshot entries whose mdId is missing (legacy
 * comment-shape) or absent from the provided heat Map (UPSP §1, ticket #1b).
 * `0.5` places them BETWEEN the lower-heat and higher-heat scored entries so
 * the LLM's positional bias treats them neither as coldest nor hottest. (Note:
 * this is the *snapshot* convention; the eviction floors in `MemoryStore` use
 * `+Infinity` for unscoreable entries — evict LAST, conservatively. The two are
 * deliberately different: the snapshot is a weak prompt-free nudge, the floor
 * is a destructive victim pick.)
 */
export const NEUTRAL_HEAT = 0.5;

/**
 * Parse an encoded entry into a {@link SnapshotEntry}.
 *
 * `content`/`created`/`last`/`mdId` are decoded shape-aware: a YAML-frontmatter
 * entry (the post-5d-migration canonical shape) is decoded via
 * `parseMetadataFrontmatter`; a legacy comment entry is decoded via
 * `parseMetadataComment` (which tolerates the optional `<!-- meta:{…} -->`
 * provenance block). This mirrors `MemoryStore.decodeEntry` / `mdIdOf` —
 * without it, a frontmatter entry's `content` would be the full raw string
 * (fence + id + dates + body), corrupting the snapshot the consolidator sees
 * and any `merge` op it produces. `key` is always the hash of the *raw*
 * encoded string (shape-agnostic), so drop ops still match across a mixed-shape
 * live set. `mdId` is the frontmatter `id` (comment-shape → `undefined`) so the
 * optional heat-sort can key into the per-entry heat Map — extracted with the
 * SAME logic as `MemoryStore.mdIdOf` so keys align across the DB boundary.
 */
export function parseEntry(encoded: string): SnapshotEntry {
  // Unified decode (architecture-deepening C1 v2): shape-aware + lenient (a
  // malformed-frontmatter fragment no longer throws — baked-in fix (a); it
  // degrades to a comment-shape minimal entry). `content` is the decoded body;
  // `mdId` is the frontmatter `id` read via typeof-string (baked-in fix (b) —
  // an id-less / comment-shape entry yields `undefined`, NOT the literal
  // "undefined" the legacy String() coerce produced), extracted with the SAME
  // logic as `MemoryStore.mdIdOf` so heat-sort keys align across the DB
  // boundary. `key` stays the hash of the *raw* encoded string (shape-agnostic)
  // so drop ops still match across a mixed-shape live set.
  const d = decodeMemoryEntry(encoded);
  return {
    key: hashEntry(encoded),
    content: d.text,
    created: d.created,
    last: d.lastReferenced,
    ...(d.id ? { mdId: d.id } : {}),
  };
}

/**
 * Build a {@link ConsolidationSnapshot} from raw encoded entries.
 *
 * Each entry is parsed (so callers can inspect content/dates/mdId), `totalChars`
 * is the joined-with-delimiter length (mirroring how the store measures budget),
 * and `snapshotBaseHash` is the order-insensitive identity of this entry set —
 * the value a {@link MergePlan} is anchored against.
 *
 * Heat-sort (UPSP §1, ticket #1b): when a non-empty `heats` Map is provided,
 * `entries` are ordered LOWEST-heat-first (a positional nudge toward dropping
 * stale entries — NO prompt change). Ties keep the original parse order
 * (stable, via an index tiebreak). An entry whose `mdId` is missing or absent
 * from the Map places at {@link NEUTRAL_HEAT} (0.5). When `heats` is omitted /
 * `undefined` / empty, entries are left in parse order — byte-identical to the
 * pre-#1b behavior (the decay-disable path parity invariant).
 *
 * `snapshotBaseHash` is computed from the raw `encodedEntries` (NOT the sorted
 * `entries`) and is order-insensitive by construction, so the heat-sort CANNOT
 * change it — the reconcile-write's `baseHashMatched` is unaffected (asserted
 * in `merge-plan.test.ts`).
 */
export function buildSnapshot(
  target: ConsolidationSnapshot["target"],
  encodedEntries: string[],
  charLimit: number,
  heats?: Map<string, number>,
): ConsolidationSnapshot {
  const entries = encodedEntries.map(parseEntry);
  return {
    target,
    entries: heats && heats.size > 0 ? sortSnapshotEntriesByHeat(entries, heats) : entries,
    totalChars: encodedEntries.join(ENTRY_DELIMITER).length,
    charLimit,
    snapshotBaseHash: snapshotBaseHash(encodedEntries),
  };
}

/**
 * Order `entries` ascending by heat, ties broken by original index (stable).
 * An entry whose `mdId` is missing or absent from `heats` places at
 * {@link NEUTRAL_HEAT}. Pure; does not mutate the input. The index tiebreak
 * makes the order deterministic regardless of the JS engine's `sort` stability.
 */
function sortSnapshotEntriesByHeat(entries: SnapshotEntry[], heats: Map<string, number>): SnapshotEntry[] {
  const heatOf = (e: SnapshotEntry): number => {
    const id = e.mdId;
    return id !== undefined && heats.has(id) ? (heats.get(id) as number) : NEUTRAL_HEAT;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const diff = heatOf(a.entry) - heatOf(b.entry);
      return diff !== 0 ? diff : a.index - b.index; // stable: parse order on ties
    })
    .map(({ entry }) => entry);
}

/** Outcome of applying a {@link MergePlan} to a live entry list. */
export type ApplyResult = {
  /** Resulting encoded entries (kept live entries in order, then merged results). */
  entries: string[];
  /** Ops that took effect. */
  applied: MergePlanOp[];
  /** Ops deferred because a referenced key was no longer present. */
  skipped: MergePlanOp[];
  /** `true` iff `snapshotBaseHash(live)` equals `plan.snapshotBaseHash`. */
  baseHashMatched: boolean;
};

/**
 * Apply `plan` to a live list of encoded entries.
 *
 * Semantics:
 * - **drop** — applied iff its `key` is still present in `liveEncoded`;
 *   otherwise deferred (the entry may have vanished concurrently).
 * - **merge** — applied iff *every* `fromKey` is present; otherwise the *whole*
 *   merge is deferred (all-or-nothing, so a half-applied merge can never lose
 *   content).
 * - Live entries not removed by any applied op are **kept in original order**
 *   (concurrent appends survive the rewrite).
 * - Applied merges append one freshly-encoded entry each at the end, stamped
 *   `created=last=today`.
 * - `baseHashMatched` reports whether the live set still matches the snapshot
 *   the plan was built from — callers can use it to pick a fast path.
 *
 * Presence is evaluated against the *original* live set for every op, so the
 * ordering of ops within the plan does not change which ops are applicable.
 */
export function applyMergePlan(liveEncoded: string[], plan: MergePlan): ApplyResult {
  const liveKeySet = new Set(liveEncoded.map(hashEntry));
  const applied: MergePlanOp[] = [];
  const skipped: MergePlanOp[] = [];
  const removedKeys = new Set<EntryHash>();
  const mergedEncodes: string[] = [];
  const now = today();

  for (const op of plan.ops) {
    if (op.op === "drop") {
      if (liveKeySet.has(op.key)) {
        applied.push(op);
        removedKeys.add(op.key);
      } else {
        skipped.push(op);
      }
    } else {
      // merge — all-or-nothing: every fromKey must still be live.
      if (op.fromKeys.every((k) => liveKeySet.has(k))) {
        applied.push(op);
        for (const k of op.fromKeys) removedKeys.add(k);
        mergedEncodes.push(serializeMetadataComment({ text: op.content, created: now, lastReferenced: now }));
      } else {
        skipped.push(op);
      }
    }
  }

  const entries = [
    ...liveEncoded.filter((encoded) => !removedKeys.has(hashEntry(encoded))),
    ...mergedEncodes,
  ];

  return {
    entries,
    applied,
    skipped,
    baseHashMatched: snapshotBaseHash(liveEncoded) === plan.snapshotBaseHash,
  };
}
