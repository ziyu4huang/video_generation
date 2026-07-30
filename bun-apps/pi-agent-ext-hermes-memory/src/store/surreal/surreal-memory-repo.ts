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

/** Escape a string into a SurrealDB double-quoted string literal. */
function sqlStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * A SurrealDB backtick record-id literal for a `tag` row keyed by `key`. Real
 * tag values (project/category/target enums + project names) never contain
 * backticks; strip defensively so a pathological value can never break out of
 * the record-id literal.
 */
function tagRecordLiteral(key: string): string {
  return "`" + key.replace(/`/g, "") + "`";
}

type Row = Partial<{
  seq: number; project: string | null; target: string; category: string | null;
  content: string; failureReason: string | null; toolState: string | null;
  correctedTo: string | null; created: string; lastReferenced: string;
  mwSuccess?: number; mwFail?: number;
  status?: string; supersedes?: number | null; supersededBy?: number | null;
  parentIds?: unknown;
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
    mwSuccess: r.mwSuccess ?? 0,
    mwFail: r.mwFail ?? 0,
    status: ((r.status as "active" | "superseded") ?? "active"),
    supersedes: r.supersedes ?? null,
    supersededBy: r.supersededBy ?? null,
    parentIds: Array.isArray(r.parentIds) ? (r.parentIds as unknown[]).map(Number) : [],
  };
}

const FIELDS = "seq, project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, mwSuccess, mwFail, status, supersedes, supersededBy, parentIds";

/** Build SurrealQL WHERE fragments + a params object for scope conditions. */
function buildScope(
  target?: MemoryTarget, project?: string | null, category?: MemoryCategory | null,
  includeSuperseded = true,
): { where: string; params: Record<string, unknown> } {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  // Supersession UX: hide superseded entries unless the caller opts in. The
  // default `true` (no filter) preserves the mutation paths' current behavior
  // (sync/replace/remove must see every row regardless of status); ONLY the
  // read/recall paths (searchMemories, fetchGraphNeighbors) pass `false`.
  // SCHEMALESS-robust: `status != 'superseded'` (NOT `status = 'active'`) so
  // pre-feature rows that lack the field (absent) are treated as active,
  // mirroring mapRow's `r.status ?? "active"` coalescing. SQLite's table has
  // a DEFAULT 'active' so it can use the strict `= 'active'` equality; the
  // SCHEMALESS store cannot.
  if (!includeSuperseded) { conds.push("status != 'superseded'"); }
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
        lastReferenced = $lastReferenced,
        mwSuccess = 0,
        mwFail = 0,
        status = 'active',
        supersedes = NONE,
        supersededBy = NONE,
        parentIds = []
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
    // Insert directly with worth values from input (mirrors sqlite sync semantics)
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
        lastReferenced = $lastReferenced,
        mwSuccess = $mwSuccess,
        mwFail = $mwFail,
        status = 'active',
        supersedes = NONE,
        supersededBy = NONE,
        parentIds = []
      RETURN ${FIELDS};
    `;
    const rows = await this.c.query<Row[]>(sql, {
      project,
      target: input.target ?? "memory",
      category,
      content,
      failureReason,
      toolState,
      correctedTo,
      created,
      lastReferenced,
      mwSuccess: input.mwSuccess ?? 0,
      mwFail: input.mwFail ?? 0,
    });
    const entry = mapRow(rows[0]);
    await this.syncGraphEdges(
      Number(entry.id),
      project,
      category,
      input.target ?? "memory",
    );
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
    const { project, target, category, limit = 10, includeSuperseded = false } = options;
    const scope = buildScope(target, project, category, includeSuperseded);
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
    const neighbors = await this.fetchGraphNeighbors(lexicalResults, { project, target, category, includeSuperseded });
    if (neighbors.length === 0) {
      // Close the no-neighbor fast path: route single-match / no-shared-
      // neighbor searches through the shared ranker so the worth multiplier
      // applies (instead of raw lastReferenced DESC). Neighbors stay empty
      // here — the ranker simply re-orders the lexical set by recency + worth.
      return rankMemoryEntries({
        candidates: lexicalResults,
        lexicalMatchIds: new Set(lexicalResults.map((m) => m.id)),
        limit,
      });
    }

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
    scope: { project?: string | null; target?: MemoryTarget; category?: MemoryCategory; includeSuperseded?: boolean },
  ): Promise<MemoryEntry[]> {
    const seedSeqs = seeds.map((m) => m.id);
    const keys = new Set<string>();
    for (const m of seeds) {
      if (m.project) keys.add(`project:${m.project}`);
      if (m.category) keys.add(`category:${m.category}`);
      if (m.target) keys.add(`target:${m.target}`);
    }
    if (keys.size === 0) return [];

    // Mirror runSearch: superseded neighbors are hidden unless opted in.
    const s = buildScope(scope.target, scope.project, scope.category, scope.includeSuperseded ?? false);
    const where = s.where ? `${s.where.replace("WHERE ", "")} AND` : "";
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories
       WHERE ${where} seq NOT IN $seedSeqs
         AND array::intersect(->tagged->tag.key, $keys) != []
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

  /**
   * Backfill `tagged` graph edges for pre-existing memory rows that have none
   * (e.g. rows written before graph-augmented search shipped). Selects memories
   * with no outgoing edge and rebuilds their edges in batched SurrealQL scripts
   * (UPSERT tag node + RELATE per implicit tag), chunked to keep each HTTP
   * request bounded. Safe to call on every startup: once all rows have edges
   * the "no-edge" set is empty and this is a single cheap SELECT. Best-effort —
   * never throws so it cannot trip the backend-factory fallback to sqlite.
   *
   * Batched (not a per-row HTTP round-trip) because a large pre-existing corpus
   * (hundreds–thousands of rows) would otherwise make startup take tens of
   * seconds one edge at a time.
   */
  async backfillGraphEdges(): Promise<number> {
    try {
      const orphans = await this.c.query<Row[]>(
        `SELECT seq, project, target, category FROM memories
         WHERE id NOT IN (SELECT VALUE in FROM tagged);`,
      );
      if (orphans.length === 0) return 0;
      // Orphan rows have no existing edges, so no prior-edge DELETE is needed.
      // Chunk so each request stays bounded for very large corpora.
      const CHUNK = 100;
      for (let i = 0; i < orphans.length; i += CHUNK) {
        const stmts: string[] = [];
        for (const r of orphans.slice(i, i + CHUNK)) {
          const seq = Number(r.seq);
          const tags: Array<{ key: string; kind: string; value: string }> = [];
          if (r.project != null) tags.push({ key: `project:${r.project}`, kind: "project", value: r.project });
          if (r.category != null) tags.push({ key: `category:${r.category}`, kind: "category", value: r.category });
          if (r.target != null) tags.push({ key: `target:${r.target}`, kind: "target", value: r.target });
          for (const t of tags) {
            stmts.push(
              `UPSERT type::record("tag", ${sqlStr(t.key)}) SET key = ${sqlStr(t.key)}, kind = ${sqlStr(t.kind)}, value = ${sqlStr(t.value)};`,
            );
            // type::record() cannot appear inline in a RELATE source/target
            // (parse error), so the tag id uses a record-id literal here.
            stmts.push(`RELATE memories:${seq}->tagged->tag:${tagRecordLiteral(t.key)};`);
          }
        }
        if (stmts.length > 0) await this.c.query(stmts.join("\n"));
      }
      return orphans.length;
    } catch {
      // Best-effort migration: a transient query failure must not abort startup
      // or trigger the sqlite fallback. Missing edges only weaken graph recall.
      return 0;
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

  async bumpMemoryWorth(id: number, successDelta = 0, failDelta = 0): Promise<void> {
    await this.c.query(
      `UPDATE memories SET mwSuccess = (mwSuccess ?? 0) + $s, mwFail = (mwFail ?? 0) + $f WHERE seq = $seq;`,
      { seq: Number(id), s: successDelta, f: failDelta },
    );
  }

  /**
   * Mark `priorId` as superseded by `newId`, and record the reverse lineage on
   * `newId`. Two UPDATEs (NOT delete+insert) so the prior row's `seq` stays
   * stable for any external lineage references — mirroring `bumpMemoryWorth`.
   * SurrealDB `memories` is SCHEMALESS, so the lineage fields are free columns;
   * `parentIds` is stored as a native array. Id stable across the supersession.
   */
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    const p = Number(priorId), n = Number(newId);
    await this.c.query(
      `BEGIN TRANSACTION;
       UPDATE memories SET status = 'superseded', supersededBy = $n WHERE seq = $p;
       UPDATE memories SET supersedes = $p, parentIds = [$p] WHERE seq = $n;
       COMMIT TRANSACTION;`,
      { p, n },
    );
  }
}
