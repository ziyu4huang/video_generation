// src/store/image-serializer.ts — ticket 07: kind=image vault-md serializer.
//
// Reuses the knowledge zettel envelope (id/created/tags/entities/relations/
// title carrier — same `## 核心想法` body shape as KnowledgeSerializer) and
// EXTENDS it with the image fields (format, dimensions, locator) plus 02's
// provenance keys (source_file, source_hash, content_hash, extractor).
// `content` = the single merged field (OCR text + vision-LLM description)
// written by file2md's extractImageCard. Atomic: one image = one card.
// `Card.graph` stays undefined for image cards in this ticket (file2md emits
// no `## 連結` section); entities/relations ride the envelope and round-trip
// through `{ ...data }` untouched.
import { stringify as stringifyYaml } from "yaml";
import type { Card } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import { splitFencedYaml } from "@repo/pi-agent-core-interface";

const CORE_IDEA_HEADER = "## 核心想法";

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Base zettel validation (mirrors KnowledgeSerializer.isValidZettel): id +
 *  created + non-empty tags whose first entry is the literal "zettel". */
function isValidZettel(data: Record<string, unknown>): boolean {
  if (data.id == null || data.id === "") return false;
  if (data.created == null || data.created === "") return false;
  if (!Array.isArray(data.tags) || data.tags.length === 0) return false;
  return String(data.tags[0]).toLowerCase() === "zettel";
}

/** Image-specific validation: record_type "image" + format + dimensions +
 *  locator. A file missing ANY of these is NOT an image card (→ []), so a
 *  plain knowledge zettel never lands here. */
function isImageCard(data: Record<string, unknown>): boolean {
  if (String(data.record_type ?? "") !== "image") return false;
  if (typeof data.format !== "string" || data.format === "") return false;
  const d = data.dimensions as Partial<ImageDimensions> | undefined;
  if (typeof d !== "object" || d === null) return false;
  if (typeof d.width !== "number" || typeof d.height !== "number") return false;
  if (typeof data.locator !== "string" || data.locator === "") return false;
  return true;
}

function extractTitle(body: string): string | undefined {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

function extractSection(body: string, header: string): string | null {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === header) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break; // next section header
    out.push(lines[i]!);
  }
  return out.join("\n").trim();
}

export class ImageSerializer implements CardSerializer<"image"> {
  readonly kind = "image" as const;

  deserialize(fileBytes: string, _opts?: { filePath?: string }): Card[] {
    const split = splitFencedYaml(fileBytes);
    if (!split) return [];
    const { data, body } = split;
    if (!isValidZettel(data) || !isImageCard(data)) return [];

    const title = extractTitle(body);
    const content = extractSection(body, CORE_IDEA_HEADER) ?? body.trim();

    // The decoded envelope (incl. image fields + provenance) becomes
    // `frontmatter`; `title` rides as the round-trip carrier, stripped on
    // serialize (same convention as KnowledgeSerializer).
    const envelope: Record<string, unknown> = { ...data };
    if (title) envelope.title = title;

    const card: Card = {
      id: String(data.id),
      kind: "image",
      content,
      frontmatter: envelope,
    };
    return [card];
  }

  serialize(card: Card): string {
    const fm = card.frontmatter;
    // Strip the round-trip `title` carrier from the YAML block — the title is
    // re-emitted as the `# ` heading, not a frontmatter key.
    const fmForYaml: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (k === "title") continue;
      fmForYaml[k] = v;
    }
    const yaml = stringifyYaml(fmForYaml, { lineWidth: 0 }).trimEnd();
    const title = typeof fm.title === "string" ? fm.title : card.id;
    return ["---", yaml, "---", "", `# ${title}`, "", CORE_IDEA_HEADER, card.content, ""].join("\n");
  }
}
