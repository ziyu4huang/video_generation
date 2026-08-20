import type { Card, CardKind } from "./card.js";

/** Owns disk (de)serialization for one CardKind. One impl per kind.
 *
 *  The store is kind-agnostic; the serializer is the kind-specific seam that
 *  abstracts over the two file backings (memory = many fenced entries per .md;
 *  knowledge = one card per vault .md). The store owns file-level assembly
 *  (which fragments concatenate into which file); the serializer owns ONE
 *  card's fragment/file. This mirrors how `memory-format.ts` already works:
 *  `serializeMetadataFrontmatter(entry)` returns one entry's fragment, the
 *  store joins them with `ENTRY_DELIMITER`. */
export interface CardSerializer<K extends CardKind = CardKind> {
  /** The kind this serializer owns. Selects the strategy at the store's
   *  per-kind registry. */
  readonly kind: K;

  /** Serialize ONE card → its on-disk representation.
   *  - memory: a single fenced frontmatter entry (`---\n<yaml>\n---\n<body>`)
   *    — the store concatenates these per file with ENTRY_DELIMITER.
   *  - knowledge: a full obsidian-md file body (`---\n<yaml>\n---\n# title…`).
   *
   *  For `kind:"knowledge"` the store does NOT call this in 06a (vault writes
   *  stay zk-owned per ticket 06 fork 1); it exists for symmetry + future
   *  round-trip and returns a byte-preserving rendering of `card`. */
  serialize(card: Card): string;

  /** Deserialize file bytes → zero or more cards.
   *  - memory: N cards (one per fenced entry in the section-md file).
   *  - knowledge: 0 or 1 card (a vault .md file; 0 when it is not a valid
   *    zettel note — e.g. fails `validateZettelNote`). */
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[];
}
