import { Database } from "bun:sqlite";

// In-memory SQLite FTS5 index for fast gallery search.
// Rebuilt lazily on first search after server start or job completion.

const db = new Database(":memory:");

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    name,
    prompt,
    command,
    model,
    data UNINDEXED,
    media_type UNINDEXED,
    created_at UNINDEXED,
    tokenize="unicode61 remove_diacritics 1"
  )
`);

let _indexed = false;

export function isIndexed(): boolean {
  return _indexed;
}

export function invalidateIndex(): void {
  _indexed = false;
}

export function buildIndex(images: any[]): void {
  db.exec("DELETE FROM images_fts");
  const stmt = db.prepare<unknown, [string, string, string, string, string, string, number]>(
    "INSERT INTO images_fts(name, prompt, command, model, data, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertAll = db.transaction((imgs: any[]) => {
    for (const img of imgs) {
      stmt.run(
        img.name ?? "",
        extractPrompt(img),
        extractCommand(img),
        extractModel(img),
        JSON.stringify(img),
        img.mediaType ?? "image",
        new Date(img.createdAt ?? 0).getTime()
      );
    }
  });
  insertAll(images);
  _indexed = true;
  db.exec("INSERT INTO images_fts(images_fts) VALUES('optimize')");
}

export function searchImages(q: string, type?: string): any[] {
  const ftsQuery = toFtsQuery(q);
  if (!ftsQuery) return [];
  try {
    const validType = type === "image" || type === "video" ? type : null;
    const rows = validType
      ? db
          .query<{ data: string }, [string, string]>(
            "SELECT data FROM images_fts WHERE images_fts MATCH ? AND media_type = ? ORDER BY rank LIMIT 200"
          )
          .all(ftsQuery, validType)
      : db
          .query<{ data: string }, [string]>(
            "SELECT data FROM images_fts WHERE images_fts MATCH ? ORDER BY rank LIMIT 200"
          )
          .all(ftsQuery);
    return rows.map((r) => JSON.parse(r.data));
  } catch {
    return [];
  }
}

// Build safe FTS5 query: each word gets prefix-match "*"
function toFtsQuery(q: string): string {
  const words = q
    .trim()
    .replace(/['"()^*]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return words.map((w) => `"${w}"*`).join(" ");
}

function extractPrompt(img: any): string {
  return img.run?.prompt ?? img.manifest?.prompt ?? "";
}

function extractCommand(img: any): string {
  return (
    img.manifest?.command ??
    img.manifest?.pipeline ??
    img.run?.command ??
    ""
  );
}

function extractModel(img: any): string {
  const m = img.manifest;
  if (!m) return "";
  if (typeof m.model === "string") return m.model;
  if (typeof m.checkpoint === "string") return m.checkpoint;
  if (Array.isArray(m.models))
    return m.models.map((x: any) => x.name ?? String(x)).join(" ");
  return "";
}
