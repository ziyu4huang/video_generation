/**
 * SurrealMemoryRepository — implements MemoryRepository against a local
 * SurrealDB server via SurrealClient. Mirrors SqliteMemoryRepository's
 * semantics (dedup identity = target+project+category+content; LIKE-style
 * matching for replace/remove; FTS @@ with a string::contains fallback).
 *
 * The DTO `id: number` is stored as the integer field `seq`; record keys are
 * Surreal's native random ids. Records are addressed by `WHERE seq = $id`.
 * No corruption layer — transient retry lives in SurrealClient.
 *
 * Note on null matching: SurrealDB v3.2.3 matches stored NULLs with the
 * `IS NULL` operator (verified live). The `IS NONE` form returns no rows
 * for a stored NULL, so it MUST NOT be used here.
 */

import type { SurrealBackend } from "./surreal-backend.js";
import type {
  MemoryRepository, MemoryEntry, MemorySyncInput, MemorySyncResult,
  MemoryUpdateResult, MemoryRemoveResult, MemoryRemoveOptions,
  MemorySearchOptions, MemoryListOptions, MemoryStats, MemoryTarget,
} from "../repository.js";
import type { MemoryCategory } from "../../types.js";
import { today, normalizeNullable, normalizeCategory } from "../memory-format.js";
import { normalizeMemoryLookupText } from "../memory-lookup.js";
import { rankMemoryEntries } from "../graph-ranker.js";

/** Max graph neighbors fetched to augment a lexical search (before ranking). */
const GRAPH_NEIGHBOR_CAP = 20;

/** Keep the earliest of two YYYY-MM-DD strings. Mirrors sqlite helper. */
function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Keep the latest of two YYYY-MM-DD strings. Mirrors sqlite helper. */
function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

type Row = Partial<{
  seq: number; project: string | null; target: string; category: string | null;
  content: string; failureReason: string | null; toolState: string | null;
  correctedTo: string | null; created: string; lastReferenced: string;
}>;

function mapRow(r: Row): MemoryEntry {
  return {
    id: Number(r.seq),
    project: r.project ?? null,
    target: (r.target ?? "memory") as MemoryTarget,
    category: (r.category ?? null) as MemoryCategory | null,
    content: r.content ?? "",
    failureReason: r.failureReason ?? null,
    toolState: r.toolState ?? null,
    correctedTo: r.correctedTo ?? null,
    created: r.created ?? today(),
    lastReferenced: r.lastReferenced ?? r.created ?? today(),
  };
}

const FIELDS = "seq, project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced";

/** Build SurrealQL WHERE fragments + a params object for scope conditions. */
function buildScope(
  target?: MemoryTarget, project?: string | null, category?: MemoryCategory | null,
): { where: string; params: Record<string, unknown> } {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (target) { conds.push("target = $target"); params.target = target; }
  if (project !== undefined) {
    // v3.2.3 matches stored NULL via `IS NULL` (NOT `IS NONE`).
    if (project === null) { conds.push("project IS NULL"); }
    else { conds.push("project = $project"); params.project = project; }
  }
  if (category !== undefined) {
    if (category === null) { conds.push("category IS NULL"); }
    else { conds.push("category = $category"); params.category = category; }
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export class SurrealMemoryRepository implements MemoryRepository {
  constructor(private readonly backend: SurrealBackend) {}

  private get c() { return this.backend.client; }

  async addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
  }): Promise<MemoryEntry> {
    const created = input.created ?? today();
    const lastReferenced = input.lastReferenced ?? created;
    const sql = `
      LET $next = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0];
      CREATE type::record("memories", $next) SET
        seq = $next,
        project = $project,
        target = $target,
        category = $category,
        content = $content,
        failureReason = $failureReason,
        toolState = $toolState,
        correctedTo = $correctedTo,
        created = $created,
        lastReferenced = $lastReferenced
      RETURN ${FIELDS};
    `;
    const rows = await this.c.query<Row[]>(sql, {
      project: input.project ?? null,
      target: input.target ?? "memory",
      category: input.category ?? null,
      content: input.content,
      failureReason: input.failureReason ?? null,
      toolState: input.toolState ?? null,
      correctedTo: input.correctedTo ?? null,
      created,
      lastReferenced,
    });
    const entry = mapRow(rows[0]);
    await this.syncGraphEdges(
      Number(entry.id),
      input.project ?? null,
      input.category ?? null,
      input.target ?? "memory",
    );
    return entry;
  }

  async syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult> {
    const content = input.content.trim();
    const project = normalizeNullable(input.project);
    const category = normalizeCategory(input.category);
    const failureReason = normalizeNullable(input.failureReason);
    const toolState = normalizeNullable(input.toolState);
    const correctedTo = normalizeNullable(input.correctedTo);
    const created = input.created?.trim() || today();
    const lastReferenced = input.lastReferenced?.trim() || created;

    const scope = buildScope(input.target, project, category);
    // Fetch the full row so we can MERGE (sqlite semantics): keep earliest
    // created, latest lastReferenced, and preserve existing non-null fields
    // rather than overwriting them with new input.
    const selectSql = `SELECT ${FIELDS} FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content ORDER BY seq ASC LIMIT 1;`;
    const existing = await this.c.query<Row[]>(selectSql, { ...scope.params, content });
    if (existing.length > 0) {
      const ex = existing[0];
      const seq = Number(ex.seq);
      const mergedCreated = minDate(ex.created ?? created, created);
      const mergedLastReferenced = maxDate(ex.lastReferenced ?? lastReferenced, lastReferenced);
      const mergedCategory = ex.category ?? category;
      const mergedFailureReason = ex.failureReason ?? failureReason;
      const mergedToolState = ex.toolState ?? toolState;
      const mergedCorrectedTo = ex.correctedTo ?? correctedTo;
      await this.c.query(
        `UPDATE memories SET category = $category, failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, created = $created, lastReferenced = $lastReferenced WHERE seq = $seq;`,
        {
          seq,
          category: mergedCategory,
          failureReason: mergedFailureReason,
          toolState: mergedToolState,
          correctedTo: mergedCorrectedTo,
          created: mergedCreated,
          lastReferenced: mergedLastReferenced,
        },
      );
      const row = (await this.c.query<Row[]>(`SELECT ${FIELDS} FROM memories WHERE seq = $seq;`, { seq }))[0];
      await this.syncGraphEdges(seq, row.project ?? null, (row.category ?? null) as MemoryCategory | null, (row.target ?? "memory") as MemoryTarget);
      return { action: "existing", entry: mapRow(row) };
    }
    const entry = await this.addMemory({
      content, target: input.target, project, category, failureReason, toolState, correctedTo, created, lastReferenced,
    });
    return { action: "inserted", entry };
  }

  async replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null; lastReferenced?: string | null;
  }): Promise<MemoryUpdateResult> {
    const normalizedOldText = normalizeMemoryLookupText(oldText);
    if (!normalizedOldText) return { matched: 0, updated: 0, entries: [] };
    const scope = buildScope(updates.target, updates.project ?? undefined);
    const nextLastReferenced = updates.lastReferenced?.trim() || today();
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old) ORDER BY seq ASC;`,
      { ...scope.params, old: normalizedOldText },
    );
    if (rows.length === 0) return { matched: 0, updated: 0, entries: [] };
    const entries: MemoryEntry[] = [];
    for (const r of rows) {
      const seq = Number(r.seq);
      await this.c.query(
        `UPDATE memories SET content = $content, category = $category, failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced WHERE seq = $seq;`,
        {
          seq,
          content: updates.content.trim(),
          category: updates.category === undefined ? r.category : normalizeNullable(updates.category),
          failureReason: updates.failureReason === undefined ? r.failureReason : normalizeNullable(updates.failureReason),
          toolState: updates.toolState === undefined ? r.toolState : normalizeNullable(updates.toolState),
          correctedTo: updates.correctedTo === undefined ? r.correctedTo : normalizeNullable(updates.correctedTo),
          lastReferenced: nextLastReferenced,
        },
      );
      // Re-fetch by seq so returned entries reflect the NEW content (sqlite
      // does getMemoryById(row.id) per row post-update).
      const refreshed = (await this.c.query<Row[]>(`SELECT ${FIELDS} FROM memories WHERE seq = $seq;`, { seq }))[0];
      if (refreshed) {
        entries.push(mapRow(refreshed));
        await this.syncGraphEdges(seq, refreshed.project ?? null, (refreshed.category ?? null) as MemoryCategory | null, (refreshed.target ?? "memory") as MemoryTarget);
      }
    }
    return { matched: rows.length, updated: rows.length, entries };
  }

  async removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const normalizedOldText = normalizeMemoryLookupText(oldText);
    if (!normalizedOldText) return { matched: 0, removed: 0 };
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`,
      { ...scope.params, old: normalizedOldText },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`, { ...scope.params, old: normalizedOldText });
    return { matched: matched.length, removed: matched.length };
  }

  async removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`,
      { ...scope.params, content: content.trim() },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`, { ...scope.params, content: content.trim() });
    return { matched: matched.length, removed: matched.length };
  }

  async searchMemories(query: string, options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    if (query.trim().length === 0) return [];
    const { project, target, category, limit = 10 } = options;
    const scope = buildScope(target, project, category);
    const tail = `ORDER BY lastReferenced DESC LIMIT ${Number(limit)};`;
    const where = scope.where ? `${scope.where.replace("WHERE ", "")} AND` : "";

    // Lexical match: FTS @@ with a string::contains fallback.
    let lexicalRows: Row[] = [];
    try {
      lexicalRows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} content @@ $q ${tail}`,
        { ...scope.params, q: query },
      );
    } catch { /* fall through to contains fallback */ }
    if (lexicalRows.length === 0) {
      lexicalRows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} string::contains(content, $q) ${tail}`,
        { ...scope.params, q: query },
      );
    }
    if (lexicalRows.length === 0) return [];
    const lexicalResults = lexicalRows.map(mapRow);

    // Graph augmentation: neighbors sharing an implicit tag with the seeds,
    // ranked together by the shared backend-neutral ranker.
    const neighbors = await this.fetchGraphNeighbors(lexicalResults, { project, target, category });
    if (neighbors.length === 0) return lexicalResults.slice(0, limit);

    return rankMemoryEntries({
      candidates: [...lexicalResults, ...neighbors],
      lexicalMatchIds: new Set(lexicalResults.map((m) => m.id)),
      limit,
    });
  }

  /**
   * Fetch graph neighbors via SurrealDB RELATE traversal: memories pointing
   * (via `tagged` edges) at any tag node shared with the seed set, excluding
   * the seeds, within the same search scope, capped. Mirrors the SQLite
   * column-equality neighbor fetch through the shared ranker for cross-backend
   * equivalence.
   */
  private async fetchGraphNeighbors(
    seeds: MemoryEntry[],
    scope: { project?: string | null; target?: MemoryTarget; category?: MemoryCategory },
  ): Promise<MemoryEntry[]> {
    const seedSeqs = seeds.map((m) => m.id);
    const keys = new Set<string>();
    for (const m of seeds) {
      if (m.project) keys.add(`project:${m.project}`);
      if (m.category) keys.add(`category:${m.category}`);
      if (m.target) keys.add(`target:${m.target}`);
    }
    if (keys.size === 0) return [];

    const s = buildScope(scope.target, scope.project, scope.category);
    const where = s.where ? `${s.where.replace("WHERE ", "")} AND` : "";
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories
       WHERE ${where} seq NOT IN $seedSeqs
         AND id IN (SELECT VALUE in FROM tagged WHERE out IN (SELECT VALUE id FROM tag WHERE key IN $keys))
       ORDER BY lastReferenced DESC LIMIT $cap;`,
      { ...s.params, seedSeqs, keys: [...keys], cap: GRAPH_NEIGHBOR_CAP },
    );
    return rows.map(mapRow);
  }

  /**
   * Idempotently sync this memory's `tagged` graph edges for its implicit tags
   * (project/category/target). Clears existing outgoing edges first, then
   * ensures each tag node exists and re-creates the edge.
   */
  private async syncGraphEdges(
    seq: number,
    project: string | null,
    category: MemoryCategory | null,
    target: MemoryTarget,
  ): Promise<void> {
    await this.c.query(`DELETE FROM tagged WHERE in = type::record("memories", $seq);`, { seq });
    const tags: Array<{ key: string; kind: string; value: string }> = [];
    if (project != null) tags.push({ key: `project:${project}`, kind: "project", value: project });
    if (category != null) tags.push({ key: `category:${category}`, kind: "category", value: category });
    if (target != null) tags.push({ key: `target:${target}`, kind: "target", value: target });
    if (tags.length === 0) return;
    for (const t of tags) {
      await this.c.query(`UPSERT type::record("tag", $key) SET key = $key, kind = $kind, value = $value;`, t);
      await this.c.query(
        `LET $mem = type::record("memories", $seq); LET $tag = type::record("tag", $key); RELATE $mem->tagged->$tag;`,
        { seq, key: t.key },
      );
    }
  }

  async getMemories(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const scope = buildScope(options.target, options.project, options.category);
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${scope.where} ORDER BY lastReferenced DESC;`,
      scope.params,
    );
    return rows.map(mapRow);
  }

  async getRecentFailures(maxAgeDays = 7, project?: string | null): Promise<MemoryEntry[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    // Mirror sqlite: a non-null project matches `project = ? OR project IS NULL`
    // so project-agnostic (null-project) failures still surface. Do NOT route
    // through the strict buildScope for project here.
    const params: Record<string, unknown> = { cutoff: cutoffStr };
    const conds: string[] = ["target = $target", "created >= $cutoff"];
    params.target = "failure";
    if (project !== undefined) {
      if (project === null) {
        conds.push("project IS NULL");
      } else {
        params.project = project;
        conds.push("(project = $project OR project IS NULL)");
      }
    }
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE ${conds.join(" AND ")} ORDER BY created DESC LIMIT 5;`,
      params,
    );
    return rows.map(mapRow);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const total = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM memories GROUP ALL;`);
    const byProject = await this.c.query<Array<{ project: string | null; count: number }>>(`SELECT project, count() AS count FROM memories GROUP BY project;`);
    const byTarget = await this.c.query<Array<{ target: string; count: number }>>(`SELECT target, count() AS count FROM memories GROUP BY target;`);
    return {
      total: total[0]?.count ?? 0,
      byProject: byProject.map((r) => ({ project: r.project ?? null, count: r.count })),
      byTarget: byTarget.map((r) => ({ target: r.target, count: r.count })),
    };
  }

  async removeMemory(id: number): Promise<boolean> {
    const seq = Number(id);
    await this.c.query(`DELETE FROM memories WHERE seq = $seq;`, { seq });
    await this.c.query(`DELETE FROM tagged WHERE in = type::record("memories", $seq);`, { seq });
    return true;
  }

  async touchMemory(id: number): Promise<void> {
    await this.c.query(`UPDATE memories SET lastReferenced = $t WHERE seq = $seq;`, { seq: Number(id), t: today() });
  }
}
