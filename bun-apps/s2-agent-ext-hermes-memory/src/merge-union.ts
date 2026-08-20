/**
 * Pure §-union merge logic for MEMORY.md (autocommit-hook effort, ticket 05).
 *
 * Both efforts APPEND entries at the end of MEMORY.md, so a forward-merge of
 * two memory-writing branches collides at the same insertion point *every
 * time*. A custom merge driver sidesteps that: split on `§` (ENTRY_DELIMITER),
 * union entries by trimmed content (dedup), rejoin — both branches' new
 * entries survive and common base entries aren't duplicated. True
 * edit-conflicts (same entry changed on both sides) keep both versions;
 * consolidation merges them later (out of scope here).
 *
 * The union logic is a PURE function (unit-tested here). The merge-driver
 * entry-point script (`scripts/pi-memory-merge.mjs`) embeds the same logic
 * dependency-free so it can run under any node/bun during a `git merge`.
 */

import { ENTRY_DELIMITER } from "./constants.js";

export interface UnionOptions {
  /** Entry separator. Default: ENTRY_DELIMITER ("\n§\n"). */
  delimiter?: string;
}

/**
 * Split a §-string into trimmed, non-empty entries. Blank entries (e.g. a
 * trailing delimiter) are dropped. Whitespace is trimmed per-entry so the
 * dedup key is the entry's content, not its incidental padding.
 */
export function splitMemoryEntries(content: string, delimiter: string = ENTRY_DELIMITER): string[] {
  if (!content) return [];
  return content
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Pure: union base + ours + theirs §-strings into a dedup'd result.
 *
 * Order is first-seen: base entries first (in base order), then ours-only
 * new entries (in ours order), then theirs-only (in theirs order). Dedup key
 * is the trimmed entry content, so whitespace-only differences collapse and
 * entries both sides added identically appear once. Rejoining uses the
 * delimiter with NO trailing newline (the driver script adds one on write).
 */
export function unionMemoryEntries(
  base: string,
  ours: string,
  theirs: string,
  options: UnionOptions = {},
): string {
  const delimiter = options.delimiter ?? ENTRY_DELIMITER;
  const baseEntries = splitMemoryEntries(base, delimiter);
  const oursEntries = splitMemoryEntries(ours, delimiter);
  const theirsEntries = splitMemoryEntries(theirs, delimiter);

  const result: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string): void => {
    if (seen.has(entry)) return; // entry already trimmed by splitMemoryEntries
    seen.add(entry);
    result.push(entry);
  };

  for (const entry of baseEntries) push(entry);
  for (const entry of oursEntries) push(entry);
  for (const entry of theirsEntries) push(entry);

  return result.join(delimiter);
}
