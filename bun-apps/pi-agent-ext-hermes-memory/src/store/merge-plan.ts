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
