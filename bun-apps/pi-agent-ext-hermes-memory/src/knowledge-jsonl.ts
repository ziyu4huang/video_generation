import type { KnowledgeRecord } from "@repo/pi-agent-ext-core-interface";

/** Result of parsing a `.knowledge.jsonl` blob (hermes-side, Option A). */
export interface KnowledgeJsonlResult {
  records: KnowledgeRecord[];
  parseErrors: { line: number; reason: string }[];
}

/** Parse a workflow `.knowledge.jsonl` blob into KnowledgeRecord[] (Option A).
 *  Mirrors zk's parseKnowledgeJsonl SHAPE (split on newlines, skip blank/`#`
 *  lines, JSON.parse, require non-empty id+title, coerce/deflate optionals) but
 *  against the core-interface KnowledgeRecord contract — pure, NO zk import.
 *  Parse errors are RECORDED, never thrown (the orchestrator ingests the valid
 *  subset and surfaces errors in the receipt). */
export function parseKnowledgeJsonl(content: string): KnowledgeJsonlResult {
  const records: KnowledgeRecord[] = [];
  const parseErrors: { line: number; reason: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      parseErrors.push({ line: i + 1, reason: `JSON parse: ${(e as Error).message}` });
      continue;
    }
    const rec = obj as Partial<KnowledgeRecord>;
    if (typeof rec.id !== "string" || rec.id === "") {
      parseErrors.push({ line: i + 1, reason: "missing/empty `id`" });
      continue;
    }
    if (typeof rec.title !== "string" || rec.title === "") {
      parseErrors.push({ line: i + 1, reason: `missing/empty \`title\` (id=${rec.id})` });
      continue;
    }
    // Coerce + default optional fields so the seam never sees undefined.
    records.push({
      id: rec.id,
      type: typeof rec.type === "string" ? rec.type : "pattern",
      title: rec.title,
      detail: typeof rec.detail === "string" ? rec.detail : "",
      tags: Array.isArray(rec.tags) ? rec.tags.map(String) : [],
      dimension: rec.dimension ?? null,
      confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
      status: typeof rec.status === "string" ? rec.status : "active",
      superseded_by: rec.superseded_by ?? null,
      entities: Array.isArray(rec.entities) ? (rec.entities as unknown[]) : undefined,
    });
  }
  return { records, parseErrors };
}
