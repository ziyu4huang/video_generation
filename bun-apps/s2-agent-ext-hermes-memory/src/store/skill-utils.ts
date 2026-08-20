import * as fs from "node:fs/promises";
import type { SkillDocument, SkillScope } from "../types.js";
import { splitFencedYaml } from "@repo/s2-agent-core-interface";
// `today` has ONE home (memory-format.ts); re-exported here so skill-store's
// existing `import { today } from "./skill-utils.js"` keeps working without a
// caller change (architecture-deepening C1 dedupe).
export { today } from "./memory-format.js";

export interface ParsedSkillFile {
  meta: Record<string, string>;
  body: string;
}

/** Coerce a parsed YAML scalar/aggregate into the historical `Record<string,
 *  string>` shape of `ParsedSkillFile.meta`. Strings pass through unchanged;
 *  numbers/booleans stringify; arrays/objects round-trip as JSON so their
 *  fields SURVIVE (the old regex parser silently dropped multi-line arrays /
 *  nested maps). The behavior change vs. the regex parser is intentional and
 *  documented — the YAML lib is the source of truth now. */
function coerceMetaValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function parseFrontmatter(raw: string): ParsedSkillFile {
  const split = splitFencedYaml(raw);
  if (!split) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(split.data)) {
    meta[key] = coerceMetaValue(value);
  }

  return { meta, body: split.body.trim() };
}

function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value);
}

export function formatFrontmatter(doc: Pick<SkillDocument, "name" | "displayName" | "description" | "version" | "created" | "updated" | "body">): string {
  const lines = [
    "---",
    `name: ${yamlDoubleQuoted(doc.name)}`,
    `description: ${yamlDoubleQuoted(doc.description)}`,
    `version: ${doc.version}`,
    `created: ${yamlDoubleQuoted(doc.created)}`,
    `updated: ${yamlDoubleQuoted(doc.updated)}`,
  ];

  if (doc.displayName && doc.displayName.trim() && doc.displayName.trim() !== doc.name) {
    lines.push(`display_name: ${yamlDoubleQuoted(doc.displayName.trim())}`);
  }

  lines.push("---", doc.body);
  return lines.join("\n");
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/--+/g, "-")
    .slice(0, 64);
}

const SKILL_SIMILARITY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "use", "using", "with", "workflow", "procedure", "step",
  "steps", "guide", "skill", "skills", "repo", "project",
]);

export function tokenizeForSimilarity(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !SKILL_SIMILARITY_STOP_WORDS.has(token));
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection++;
  }

  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

export function buildSkillId(scope: SkillScope, slug: string, projectName?: string | null): string {
  return scope === "project" ? `project:${projectName ?? ""}:${slug}` : `global:${slug}`;
}

export function parseSkillId(skillId: string): { scope: SkillScope; projectName?: string; slug: string } | null {
  if (skillId.startsWith("global:")) {
    return { scope: "global", slug: skillId.slice("global:".length) };
  }

  if (skillId.startsWith("project:")) {
    const rest = skillId.slice("project:".length);
    const idx = rest.indexOf(":");
    if (idx <= 0 || idx === rest.length - 1) return null;
    return {
      scope: "project",
      projectName: rest.slice(0, idx),
      slug: rest.slice(idx + 1),
    };
  }

  return null;
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
