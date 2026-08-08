/**
 * Wayfinder map + ticket STORE ops — the fs layer over the pure data model in
 * `./model.ts`. Local-markdown store under `.planning/<effort>/`.
 *
 *   map.md            — the index (Destination / Notes / Decisions so far /
 *                       Not yet specified / Out of scope)
 *   tickets/NN-slug.md — one decision ticket (YAML frontmatter + ## Question)
 *
 * The store ops (readMap / writeMap / writeTicket / appendDecision / closeTicket /
 * touchEffortManifest) build on the pure parsers/serializers/helpers in model.ts;
 * the status/move lifecycle ops (readEffortMeta / setEffortStatus /
 * completeEffort) live in `./lifecycle.ts`. (Split out of the former monolithic
 * map.ts — model.ts is the fs-free core, lifecycle.ts the status/move layer.)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  effortDir,
  type MapDecision,
  parseBulletList,
  parseDecisionLine,
  parseMapBody,
  parseMapFrontmatter,
  parseTicketFile,
  serializeMapFrontmatter,
  serializeTicket,
  type Ticket,
  today,
  type WayfindMap,
} from "./model.js";

// ─── fs ops ─────────────────────────────────────────────────────────────────

/** Bump the manifest's `last:` date in place. No-op when there's no map or no
 *  front-matter (legacy-safe). The body after the closing `---` is preserved
 *  byte-for-byte — only the leading front-matter block is rewritten. */
export function touchEffortManifest(cwd: string, effort: string): void {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return;
  const raw = readFileSync(mapPath, "utf-8");
  const { meta } = parseMapFrontmatter(raw);
  if (!meta) return; // legacy / no manifest → no-op
  const todayStr = today();
  const replaced = raw.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_full, fmBody: string) => {
    const lines = fmBody.split(/\r?\n/);
    const lastIdx = lines.findIndex((l) => /^last:\s*/.test(l));
    if (lastIdx >= 0) {
      lines[lastIdx] = `last: ${todayStr}`;
    } else {
      const effortIdx = lines.findIndex((l) => /^effort:\s*/.test(l));
      if (effortIdx >= 0) lines.splice(effortIdx + 1, 0, `last: ${todayStr}`);
      else lines.push(`last: ${todayStr}`);
    }
    return `---\n${lines.join("\n")}\n---`;
  });
  if (replaced === raw) return;
  writeFileSync(mapPath, replaced, "utf-8");
}

export function readMap(cwd: string, effort: string): WayfindMap | null {
  const dir = effortDir(cwd, effort);
  const mapPath = join(dir, "map.md");
  if (!existsSync(mapPath)) return null;

  const { meta, body } = parseMapFrontmatter(readFileSync(mapPath, "utf-8"));
  const sections = parseMapBody(body);
  const decisions = (sections["Decisions so far"] ?? "")
    .split(/\r?\n/)
    .map(parseDecisionLine)
    .filter((d): d is MapDecision => d !== null);
  const fog = parseBulletList(sections["Not yet specified"] ?? "");
  const outOfScope = parseBulletList(sections["Out of scope"] ?? "");

  const ticketsDir = join(dir, "tickets");
  const tickets: Ticket[] = [];
  if (existsSync(ticketsDir)) {
    for (const file of readdirSync(ticketsDir).sort()) {
      const m = file.match(/^(\d+)-(.+)\.md$/);
      if (!m) continue;
      const content = readFileSync(join(ticketsDir, file), "utf-8");
      tickets.push(parseTicketFile(content, m[1], m[2]));
    }
  }

  return {
    effort,
    destination: sections.Destination ?? "",
    notes: sections.Notes ?? "",
    decisions,
    fog,
    outOfScope,
    tickets,
    meta,
  };
}

/** Write a brand-new map (map.md + tickets dir). Used by chartMap. Does not
 *  overwrite tickets — use resolveTicket / writeTicket for those. */
export function writeMap(cwd: string, map: WayfindMap): void {
  const dir = effortDir(cwd, map.effort);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  const body = [
    `# Wayfinder map: ${map.effort}`,
    "",
    "## Destination",
    "",
    map.destination.trim(),
    "",
    "## Notes",
    "",
    map.notes.trim() || "_(none)_",
    "",
    "## Decisions so far",
    "",
    map.decisions.length > 0
      ? map.decisions.map((d) => `- [${d.title}](${d.link}) — ${d.gist}`).join("\n")
      : "<!-- none yet -->",
    "",
    "## Not yet specified",
    "",
    map.fog.length > 0 ? map.fog.map((f) => `- ${f}`).join("\n") : "<!-- none -->",
    "",
    "## Out of scope",
    "",
    map.outOfScope.length > 0 ? map.outOfScope.map((f) => `- ${f}`).join("\n") : "<!-- none -->",
    "",
  ].join("\n");
  // Emit front-matter only when meta is present — legacy callers and the ~377
  // existing prose-only maps stay byte-compatible (no front-matter added on rewrite).
  const front = map.meta ? serializeMapFrontmatter({ ...map.meta, last: today() }) : "";
  writeFileSync(join(dir, "map.md"), front + body, "utf-8");
}

/** Write (create or update) a single ticket file. */
export function writeTicket(cwd: string, effort: string, t: Ticket): void {
  const dir = join(effortDir(cwd, effort), "tickets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}-${t.slug}.md`), serializeTicket(t), "utf-8");
  // A ticket mutation is a manifest touchpoint — bump `last:` (no-op on legacy/no manifest).
  touchEffortManifest(cwd, effort);
}

/** Append a one-line pointer to the map's Decisions so far (used on resolve). */
export function appendDecision(cwd: string, effort: string, decision: MapDecision): void {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return;
  const existing = readFileSync(mapPath, "utf-8");
  const line = `- [${decision.title}](${decision.link}) — ${decision.gist}`;
  // Insert after the "## Decisions so far" heading's block.
  const updated = existing.replace(/(## Decisions so far\s*\n(?:.*\n)*?)(\n##\s|$)/, (_full, head, tail) => {
    const block = head as string;
    const blockTrimmed = block.replace(/\s+$/, "");
    return `${blockTrimmed}\n${line}\n${tail}`;
  });
  writeFileSync(mapPath, updated, "utf-8");
  // A decision mutation is a manifest touchpoint — bump `last:` (no-op on legacy/no manifest).
  touchEffortManifest(cwd, effort);
}

/** Close a ticket: set status "closed" + a resolution, then persist. Returns
 *  true when it changed the file, false when the ticket was already closed with
 *  the same resolution (idempotent — used by syncChainState's loop). */
export function closeTicket(cwd: string, effort: string, ticket: Ticket, resolution: string): boolean {
  if (ticket.status === "closed" && (ticket.resolution ?? "") === resolution) return false;
  writeTicket(cwd, effort, { ...ticket, status: "closed", resolution });
  return true;
}
