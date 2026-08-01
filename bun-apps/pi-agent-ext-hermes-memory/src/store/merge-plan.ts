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
import { parseMetadataComment, serializeMetadataComment, today } from "./memory-format.js";

/** 16-hex-char sha256 digest of an encoded entry. */
export type EntryHash = string;

/** A single entry as captured in a consolidation snapshot. */
export type SnapshotEntry = { key: EntryHash; content: string; created: string; last: string };

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
 * Parse an encoded entry into a {@link SnapshotEntry}.
 *
 * `content`/`created`/`last` are decoded from the trailing
 * `<!-- created=…, last=… -->` metadata comment (via `parseMetadataComment`,
 * which also tolerates the optional `<!-- meta:{…} -->` provenance block), and
 * `key` is the content hash of the *raw* encoded string.
 */
export function parseEntry(encoded: string): SnapshotEntry {
  const { text, created, lastReferenced } = parseMetadataComment(encoded);
  return { key: hashEntry(encoded), content: text, created, last: lastReferenced };
}

/**
 * Build a {@link ConsolidationSnapshot} from raw encoded entries.
 *
 * Each entry is parsed (so callers can inspect content/dates), `totalChars` is
 * the joined-with-delimiter length (mirroring how the store measures budget),
 * and `snapshotBaseHash` is the order-insensitive identity of this entry set —
 * the value a {@link MergePlan} is anchored against.
 */
export function buildSnapshot(
  target: ConsolidationSnapshot["target"],
  encodedEntries: string[],
  charLimit: number,
): ConsolidationSnapshot {
  return {
    target,
    entries: encodedEntries.map(parseEntry),
    totalChars: encodedEntries.join(ENTRY_DELIMITER).length,
    charLimit,
    snapshotBaseHash: snapshotBaseHash(encodedEntries),
  };
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
