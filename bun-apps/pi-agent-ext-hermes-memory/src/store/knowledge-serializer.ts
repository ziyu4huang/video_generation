/**
 * KnowledgeSerializer — the `CardSerializer` for kind "knowledge".
 *
 * READS vault obsidian-md knowledge-cards (one card per vault `.md` file, the
 * zk `renderCard` output) into `Card { kind: "knowledge" }`. The store is
 * read-only for knowledge in 06a (vault writes stay zk-owned per ticket 06
 * fork 1); `serialize` is provided for symmetry + future round-trip and is NOT
 * invoked by the store in 06a.
 *
 * Parsing:
 *  - Split the `---` YAML frontmatter block from the body; tolerate a missing
 *    block → return `[]`.
 *  - Validate zettel (mirror `validateZettelNote`): require `id`, `created`,
 *    `tags` with `tags[0] === "zettel"`. Invalid → return `[]` (defensive —
 *    never throw on one malformed vault file).
 *  - `content` = the body under `## 核心想法` (until the next `## ` section);
 *    fall back to the whole body if the section is absent.
 *  - `graph.links`  = `[[slug]]` wiki-links parsed from the `## 連結` section.
 *  - `graph.entities` = additive `entities: [type:name,…]` frontmatter.
 *  - `graph.relations` = additive `relations: [{s,rel,o},…]` frontmatter
 *    (ticket 03; absent in the 06a fixture → undefined).
 *
 * `Card.frontmatter` carries the whole decoded YAML envelope PLUS a round-trip
 * `title` carrier (the `# ` heading) so `serialize` can re-emit it; `serialize`
 * strips `title` from the YAML block (zk renders it as the heading, not a
 * frontmatter key).
 */

import { stringify as stringifyYaml } from "yaml";
import type { Card, CardGraph } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import { splitFencedYaml } from "./frontmatter-codec.js";
import { normalizeRelation } from "./relation-schema.js";

const FENCE = "---";
const CORE_IDEA_HEADER = "## 核心想法";
const LINKS_HEADER = "## 連結";
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/** Mirror `validateZettelNote`: require id/created + a non-empty `tags` whose
 *  first entry is the literal "zettel". Defensive (never throws). */
function isValidZettel(data: Record<string, unknown>): boolean {
  if (data.id == null || data.id === "") return false;
  if (data.created == null || data.created === "") return false;
  if (!Array.isArray(data.tags) || data.tags.length === 0) return false;
  return String(data.tags[0]).toLowerCase() === "zettel";
}

/** The first `# heading` (h1) line of the body, or undefined. Excludes h2+
 *  (`## …`) because the match requires a space immediately after the single
 *  `#`. */
function extractTitle(body: string): string | undefined {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

/** The body text under a `## <header>` section, up to the next `## ` section
 *  header or end of body (trimmed); null when the header is absent. */
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

/** All `[[slug]]` wiki-link targets found in a section body. */
function parseWikiLinks(section: string | null): string[] {
  if (!section) return [];
  const links: string[] = [];
  for (const line of section.split("\n")) {
    for (const m of line.matchAll(WIKI_LINK_RE)) links.push(m[1]!.trim());
  }
  return links;
}

/** Parse additive `entities: [type:name,…]` frontmatter → typed entities.
 *  Splits each string on the FIRST `:` (names may not contain one). */
function parseEntities(raw: unknown): { type: string; name: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { type: string; name: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const idx = item.indexOf(":");
    if (idx <= 0) continue;
    out.push({ type: item.slice(0, idx).trim(), name: item.slice(idx + 1).trim() });
  }
  return out.length > 0 ? out : undefined;
}

/** Parse additive `relations: [{s,rel,o},…]` frontmatter → typed relations
 *  (ticket 03; absent in the 06a fixture → undefined). */
function parseRelations(raw: unknown): { s: string; rel: string; o: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { s: string; rel: string; o: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.s === "string" && typeof rec.rel === "string" && typeof rec.o === "string") {
      // Canonicalize on READ (D3): alias-map the core 6 onto their canonical
      // key; free-form predicates pass through unchanged. Stored as-emitted —
      // the only write-site that canonicalizes is the serializer write-back.
      out.push({ s: rec.s, rel: normalizeRelation(rec.rel), o: rec.o });
    }
  }
  return out.length > 0 ? out : undefined;
}

export class KnowledgeSerializer implements CardSerializer<"knowledge"> {
  readonly kind = "knowledge" as const;

  deserialize(fileBytes: string, _opts?: { filePath?: string }): Card[] {
    const split = splitFencedYaml(fileBytes);
    if (!split) return [];
    const { data, body } = split;
    if (!isValidZettel(data)) return [];
    // ticket 07 — image cards carry record_type "image" and are owned by
    // ImageSerializer; never also deserialize them as knowledge.
    if (String(data.record_type ?? "") === "image") return [];

    const title = extractTitle(body);
    const content = extractSection(body, CORE_IDEA_HEADER) ?? body.trim();
    const linksSection = extractSection(body, LINKS_HEADER);
    const links = parseWikiLinks(linksSection);
    const entities = parseEntities(data.entities);
    const relations = parseRelations(data.relations);

    const graph: CardGraph = {};
    if (links.length > 0) graph.links = links;
    if (entities) graph.entities = entities;
    if (relations) graph.relations = relations;

    // The decoded envelope becomes `frontmatter`; `title` is added as a
    // round-trip carrier for serialize (stripped from the YAML block there).
    // FIX3 (fix-wave 03): DROP the raw `relations` entry — `card.graph.relations`
    // is the single canonical truth (already normalized in parseRelations), and
    // keeping the raw alias in the envelope would persist two divergent copies
    // (envelope vs graph). serialize() re-emits the canonical block from
    // `card.graph.relations`, so the round-trip is unaffected.
    const envelope: Record<string, unknown> = { ...data };
    delete envelope.relations;
    if (title) envelope.title = title;

    const card: Card = {
      id: String(data.id),
      kind: "knowledge",
      content,
      frontmatter: envelope,
      ...(Object.keys(graph).length > 0 ? { graph } : {}),
    };
    return [card];
  }

  serialize(card: Card): string {
    const fm = card.frontmatter;
    // Strip the round-trip `title` carrier from the YAML block — zk renders
    // the title as the `# ` heading, not a frontmatter key.
    const fmForYaml: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (k === "title") continue;
      fmForYaml[k] = v;
    }
    // ticket 03 T4 — relations write-back: emit the CANONICAL relations from
    // `card.graph.relations` (already normalized on read), overriding any raw
    // envelope entry that still carries the un-normalized alias. Drop the key
    // entirely when there are none so we emit no empty `relations:` block.
    const rels = card.graph?.relations;
    if (Array.isArray(rels) && rels.length > 0) {
      fmForYaml.relations = rels.map((r) => ({ s: r.s, rel: r.rel, o: r.o }));
    } else {
      delete fmForYaml.relations;
    }
    const yaml = stringifyYaml(fmForYaml, { lineWidth: 0 }).trimEnd();
    const title = typeof fm.title === "string" ? fm.title : "";
    const lines: string[] = [FENCE, yaml, FENCE];
    if (title) lines.push(`# ${title}`, "");
    lines.push(CORE_IDEA_HEADER, card.content);
    return lines.join("\n");
  }
}
