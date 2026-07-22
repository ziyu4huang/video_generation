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
      CREATE memories SET
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
    return mapRow(rows[0]);
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
    const selectSql = `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content LIMIT 1;`;
    const existing = await this.c.query<Row[]>(selectSql, { ...scope.params, content });
    if (existing.length > 0) {
      const seq = Number(existing[0].seq);
      await this.c.query(
        `UPDATE memories SET failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced WHERE seq = $seq RETURN ${FIELDS};`,
        { seq, failureReason, toolState, correctedTo, lastReferenced },
      );
      const row = (await this.c.query<Row[]>(`SELECT ${FIELDS} FROM memories WHERE seq = $seq;`, { seq }))[0];
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
    if (!oldText.trim()) return { matched: 0, updated: 0, entries: [] };
    const scope = buildScope(updates.target, updates.project ?? undefined);
    const nextLastReferenced = updates.lastReferenced?.trim() || today();
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old) ORDER BY seq ASC;`,
      { ...scope.params, old: oldText },
    );
    if (rows.length === 0) return { matched: 0, updated: 0, entries: [] };
    for (const r of rows) {
      await this.c.query(
        `UPDATE memories SET content = $content, category = $category, failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced WHERE seq = $seq;`,
        {
          seq: Number(r.seq),
          content: updates.content.trim(),
          category: updates.category === undefined ? r.category : normalizeNullable(updates.category),
          failureReason: updates.failureReason === undefined ? r.failureReason : normalizeNullable(updates.failureReason),
          toolState: updates.toolState === undefined ? r.toolState : normalizeNullable(updates.toolState),
          correctedTo: updates.correctedTo === undefined ? r.correctedTo : normalizeNullable(updates.correctedTo),
          lastReferenced: nextLastReferenced,
        },
      );
    }
    return { matched: rows.length, updated: rows.length, entries: rows.map(mapRow) };
  }

  async removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    if (!oldText.trim()) return { matched: 0, removed: 0 };
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`,
      { ...scope.params, old: oldText },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`, { ...scope.params, old: oldText });
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
    try {
      const rows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} content @@ $q ${tail}`,
        { ...scope.params, q: query },
      );
      if (rows.length > 0) return rows.map(mapRow);
    } catch { /* fall through to contains fallback */ }
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE ${where} string::contains(content, $q) ${tail}`,
      { ...scope.params, q: query },
    );
    return rows.map(mapRow);
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
    const scope = buildScope("failure", project);
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE created >= $cutoff ${scope.where ? `AND ${scope.where.replace("WHERE ", "")}` : ""} ORDER BY created DESC LIMIT 5;`,
      { cutoff: cutoffStr, ...scope.params },
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
    await this.c.query(`DELETE FROM memories WHERE seq = $seq;`, { seq: Number(id) });
    return true;
  }

  async touchMemory(id: number): Promise<void> {
    await this.c.query(`UPDATE memories SET lastReferenced = $t WHERE seq = $seq;`, { seq: Number(id), t: today() });
  }
}
