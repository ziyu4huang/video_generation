// src/store/frontmatter-codec.ts — the ONE fs-free fence-split leaf for fenced
// YAML frontmatter (architecture-deepening / Candidate 1). All card/entry codecs
// (memory-format, knowledge-serializer, skill-utils, + the future planning
// codec) delegate here instead of hand-rolling their own `---` scan. Mirrors the
// knowledge-serializer splitFrontmatter shape (proven); never throws.
import { parse as parseYaml } from "yaml";

const FENCE = "---";

/** Split a leading `---` YAML frontmatter block from the body. Returns null on
 *  a missing/malformed fence (never throws). The single source of truth for
 *  "how a fenced card splits" — replaces the 3 drifting hand-rolled copies. */
export function splitFencedYaml(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0]!.trim() !== FENCE) return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(lines.slice(1, end).join("\n"));
    data = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}
