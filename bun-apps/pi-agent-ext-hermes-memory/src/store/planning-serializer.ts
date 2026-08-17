// src/store/planning-serializer.ts — CardSerializers for planning-cards
// (Phase-2 / ticket 08). Self-contained .planning md parsing (mirrors the
// KnowledgeSerializer pattern; no wayfind import — the md format is the
// contract).
//
//  - PlanningEffortSerializer: deserialize `<effort>/map.md` -> 1 planning-effort Card.
//  - PlanningTicketSerializer: deserialize `<effort>/tickets/NN-slug.md` -> 1 planning-ticket Card.
//
// deserialize REQUIRES opts.filePath (the source path) to derive the effort
// slug (+ ticket no/slug); returns [] if the path is not a planning artifact or
// the md has no frontmatter. serialize round-trips for symmetry (the store does
// NOT call it for planning in 08 — .planning md is git-canonical; writes stay
// wayfind-owned).
import type { Card, CardGraph } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import { parsePlanningPath, planningEffortId, planningTicketId } from "./planning-id.js";
import { splitFencedYaml } from "@repo/pi-agent-core-interface";
import {
  extractTitle,
  extractResolutionGist,
  parseBlockedBy,
  extractCitedPaths,
  parseDependsOn,
} from "./planning-parse.js";

function effortCard(mapBytes: string, filePath: string): Card | null {
  const info = parsePlanningPath(filePath);
  if (!info || info.kind !== "planning-effort") return null;
  const split = splitFencedYaml(mapBytes);
  if (!split) return null;
  const { data, body } = split;
  const title = extractTitle(body);
  const links: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/tickets\/(\d+)-[^)\s]+\.md/g)) {
    const no = m[1]!;
    if (!seen.has(no)) {
      seen.add(no);
      links.push(no);
    }
  }
  const graph: CardGraph | undefined = links.length > 0 ? { links } : undefined;
  const frontmatter: Record<string, unknown> = {
    effort: info.effort,
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(title ? { title } : {}),
  };
  return {
    id: planningEffortId(info.effort),
    kind: "planning-effort",
    content: body.trim(),
    frontmatter,
    ...(graph ? { graph } : {}),
  };
}

function ticketCard(ticketBytes: string, filePath: string): Card | null {
  const info = parsePlanningPath(filePath);
  if (!info || info.kind !== "planning-ticket" || !info.ticketNo) return null;
  const split = splitFencedYaml(ticketBytes);
  if (!split) return null;
  const { data, body } = split;
  const title = extractTitle(body);
  const blockedBy = parseBlockedBy(data["blocked by"]);
  const dependsOn = parseDependsOn(data["depends_on"]);
  const resolutionGist = extractResolutionGist(body);
  const citedPaths = extractCitedPaths(body);
  const selfId = planningTicketId(info.effort, info.ticketNo);
  const relations: { s: string; rel: string; o: string }[] = [];
  for (const dep of blockedBy) {
    relations.push({ s: selfId, rel: "blocked-by", o: planningTicketId(info.effort, dep) });
  }
  for (const path of citedPaths) {
    relations.push({ s: selfId, rel: "cites", o: path });
  }
  for (const path of dependsOn) {
    relations.push({ s: selfId, rel: "depends_on", o: path });
  }
  const graph: CardGraph | undefined = relations.length > 0 ? { relations } : undefined;
  const frontmatter: Record<string, unknown> = {
    id: info.ticketNo,
    slug: info.slug ?? "",
    ...(typeof data.type === "string" ? { type: data.type } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.claimed === "string" && data.claimed.length > 0 ? { claimed: data.claimed } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(resolutionGist ? { resolutionGist } : {}),
    ...(title ? { title } : {}),
  };
  return {
    id: selfId,
    kind: "planning-ticket",
    content: body.trim(),
    frontmatter,
    ...(graph ? { graph } : {}),
  };
}

export class PlanningEffortSerializer implements CardSerializer<"planning-effort"> {
  readonly kind = "planning-effort" as const;
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[] {
    if (!opts?.filePath) return [];
    const card = effortCard(fileBytes, opts.filePath);
    return card ? [card] : [];
  }
  serialize(card: Card): string {
    const fm = card.frontmatter;
    const lines: string[] = ["---"];
    if (typeof fm.status === "string") lines.push(`status: ${fm.status}`);
    lines.push("---", "");
    // card.content is the canonical body INCLUDING its H1 (deserialize trims
    // the post-fence body verbatim); emitting `# title` separately would
    // duplicate the heading and break the round-trip fixed point (C1 golden).
    lines.push(card.content);
    return lines.join("\n");
  }
}

export class PlanningTicketSerializer implements CardSerializer<"planning-ticket"> {
  readonly kind = "planning-ticket" as const;
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[] {
    if (!opts?.filePath) return [];
    const card = ticketCard(fileBytes, opts.filePath);
    return card ? [card] : [];
  }
  serialize(card: Card): string {
    const fm = card.frontmatter;
    const lines: string[] = ["---"];
    if (typeof fm.type === "string") lines.push(`type: ${fm.type}`);
    if (typeof fm.status === "string") lines.push(`status: ${fm.status}`);
    if (typeof fm.claimed === "string") lines.push(`claimed: ${fm.claimed}`);
    if (Array.isArray(fm.blockedBy) && (fm.blockedBy as string[]).length > 0) {
      lines.push(`blocked by: ${(fm.blockedBy as string[]).join(", ")}`);
    }
    lines.push("---", "");
    // See PlanningEffortSerializer.serialize: content already carries the H1 —
    // do not re-emit `# title` (round-trip fixed point, C1 golden).
    lines.push(card.content);
    return lines.join("\n");
  }
}
