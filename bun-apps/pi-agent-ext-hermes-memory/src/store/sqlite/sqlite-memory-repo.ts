/**
 * SqliteMemoryRepository — async, backend-neutral(ish) repository wrapping the
 * SQLite memory store. Ports the free functions of `sqlite-memory-store.ts`
 * into a class that implements `MemoryRepository`.
 *
 * Every public method wraps its body in
 *   `runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => { ... }))`
 * absorbing the corruption-recovery + transient-retry wrappers that today live
 * at call sites. `withCorruptionRecovery` is synchronous, so it MUST sit INSIDE
 * `runWithTransientRetry` — otherwise its sync try/catch sees a Promise and a
 * later async corruption rejection bypasses the rebuild. The SQL bodies are
 * copied verbatim from the original free
 * functions (same SQL, same params, same logic); the SQLite driver calls are
 * sync, so we just `return` their result from the async method.
 *
 * This file does NOT import the SQLite driver directly — it goes through
 * `SqliteBackend.getDb()`. The old `sqlite-memory-store.ts` stays intact until
 * Task 8 sweeps the handler call sites; both coexist.
 */

import type { SqliteBackend, DatabaseLike } from "./sqlite-backend.js";
import { runWithTransientRetry } from "./sqlite-backend.js";
import type {
  MemoryRepository,
  MemoryEntry,
  MemorySyncInput,
  MemorySyncResult,
  MemoryUpdateResult,
  MemoryRemoveResult,
  MemoryRemoveOptions,
  MemorySearchOptions,
  MemoryListOptions,
  MemoryStats,
  MemoryTarget,
} from "../repository.js";
import type { MemoryCategory } from "../../types.js";
import { buildFallbackFts5Query, isFts5QueryError, normalizeFts5Query } from "./fts-query.js";
import { normalizeMemoryLookupText } from "../memory-lookup.js";
import { today, normalizeNullable, normalizeCategory } from "../memory-format.js";
import { rankMemoryEntries } from "../graph-ranker.js";

/** Max graph neighbors fetched to augment a lexical search (before ranking). */
const GRAPH_NEIGHBOR_CAP = 20;


// ---------------------------------------------------------------------------
// Internal helpers (DB-scoped, not exported).
// ---------------------------------------------------------------------------

const MEMORY_SELECT_COLUMNS = `
  id,
  project,
  target,
  category,
  content,
  failure_reason,
  tool_state,
  corrected_to,
  created,
  last_referenced,
  mw_success,
  mw_fail,
  status,
  supersedes,
  superseded_by,
  parent_ids
`;

type MemoryRow = {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
  mw_success: number;
  mw_fail: number;
  status: string | null;
  supersedes: number | null;
  superseded_by: number | null;
  parent_ids: string | null;
};

/**
 * Decode the `parent_ids` JSON column defensively. The column is owned by the
 * supersession lineage (set by `supersedeMemory`); legacy/NULL rows decode to
 * `[]`. Malformed JSON or non-array payloads also fall back to `[]` so a
 * corrupted cell can never break a read.
 */
function parseParentIds(raw: string | null): number[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function mapRow(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    project: row.project,
    target: row.target as MemoryTarget,
    category: row.category as MemoryCategory | null,
    content: row.content,
    failureReason: row.failure_reason,
    toolState: row.tool_state,
    correctedTo: row.corrected_to,
    created: row.created,
    lastReferenced: row.last_referenced,
    mwSuccess: row.mw_success,
    mwFail: row.mw_fail,
    status: (row.status || "active") as "active" | "superseded",
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    parentIds: parseParentIds(row.parent_ids),
  };
}

function buildScopeConditions(
  params: unknown[],
  target?: string,
  project?: string | null,
  category?: MemoryCategory | null,
): string[] {
  const conditions: string[] = [];

  if (target) {
    conditions.push("target = ?");
    params.push(target);
  }

  if (project !== undefined) {
    if (project === null) {
      conditions.push("project IS NULL");
    } else {
      conditions.push("project = ?");
      params.push(project);
    }
  }

  if (category !== undefined) {
    if (category === null) {
      conditions.push("category IS NULL");
    } else {
      conditions.push("category = ?");
      params.push(category);
    }
  }

  return conditions;
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Run `fn` inside an IMMEDIATE transaction on the given connection.
 * See sqlite-memory-store.ts runExclusive for the rationale.
 */
function runExclusive<T>(db: DatabaseLike, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* tx may already have rolled back */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly backend: SqliteBackend) {}

  private get db(): DatabaseLike {
    return this.backend.getDb();
  }

  private getMemoryById(id: number): MemoryEntry | null {
    const row = this.db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
      WHERE id = ?
    `).get(id) as MemoryRow | undefined;

    return row ? mapRow(row) : null;
  }

  async addMemory(input: {
    content: string;
    target?: MemoryTarget;
    project?: string | null;
    category?: MemoryCategory | null;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    created?: string;
    lastReferenced?: string;
  }): Promise<MemoryEntry> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const content = input.content;
      const target = input.target ?? "memory";
      const project = input.project ?? null;
      const category = input.category ?? null;
      const failureReason = input.failureReason ?? null;
      const toolState = input.toolState ?? null;
      const correctedTo = input.correctedTo ?? null;
      const created = input.created ?? today();
      const lastReferenced = input.lastReferenced ?? created;

      const result = this.db.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, mw_success, mw_fail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, 0, 0);

      return {
        id: Number(result.lastInsertRowid),
        project,
        target,
        category,
        content,
        failureReason,
        toolState,
        correctedTo,
        created,
        lastReferenced,
        mwSuccess: 0,
        mwFail: 0,
        status: "active",
        supersedes: null,
        supersededBy: null,
        parentIds: [],
      };
    }));
  }

  async syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const content = input.content.trim();
      const project = normalizeNullable(input.project);
      const category = normalizeCategory(input.category);
      const failureReason = normalizeNullable(input.failureReason);
      const toolState = normalizeNullable(input.toolState);
      const correctedTo = normalizeNullable(input.correctedTo);
      const created = input.created?.trim() || today();
      const lastReferenced = input.lastReferenced?.trim() || created;

      const params: unknown[] = [];
      const conditions = buildScopeConditions(params, input.target, project, category);
      conditions.push("content = ?");
      params.push(content);

      // Dedup identity is project + target + category + content. The read-then-
      // write is wrapped in BEGIN IMMEDIATE so a concurrent connection cannot
      // pass the same SELECT and also INSERT (see runExclusive).
      return runExclusive(this.db, () => {
        const existing = this.db.prepare(`
          SELECT ${MEMORY_SELECT_COLUMNS}
          FROM memories
          WHERE ${conditions.join(" AND ")}
          ORDER BY id ASC
          LIMIT 1
        `).get(...params) as MemoryRow | undefined;

        if (!existing) {
          const entry: MemoryEntry = {
            id: 0, // overwritten below
            project,
            target: input.target,
            category,
            content,
            failureReason,
            toolState,
            correctedTo,
            created,
            lastReferenced,
            mwSuccess: input.mwSuccess ?? 0,
            mwFail: input.mwFail ?? 0,
            status: "active",
            supersedes: null,
            supersededBy: null,
            parentIds: [],
          };
          const result = this.db.prepare(`
            INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, mw_success, mw_fail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(project, input.target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, input.mwSuccess ?? 0, input.mwFail ?? 0);
          entry.id = Number(result.lastInsertRowid);
          return { action: "inserted" as const, entry };
        }

        const updatedCreated = minDate(existing.created, created);
        const updatedLastReferenced = maxDate(existing.last_referenced, lastReferenced);
        const updatedCategory = (existing.category as MemoryCategory | null) ?? category;
        const updatedFailureReason = existing.failure_reason ?? failureReason;
        const updatedToolState = existing.tool_state ?? toolState;
        const updatedCorrectedTo = existing.corrected_to ?? correctedTo;

        this.db.prepare(`
          UPDATE memories
          SET category = ?, failure_reason = ?, tool_state = ?, corrected_to = ?, created = ?, last_referenced = ?
          WHERE id = ?
        `).run(
          updatedCategory,
          updatedFailureReason,
          updatedToolState,
          updatedCorrectedTo,
          updatedCreated,
          updatedLastReferenced,
          existing.id,
        );

        return {
          action: "existing" as const,
          entry: this.getMemoryById(existing.id)!,
        };
      });
    }));
  }

  async replaceSyncedMemories(
    oldText: string,
    updates: {
      content: string;
      target: MemoryTarget;
      project?: string | null;
      category?: MemoryCategory | null;
      failureReason?: string | null;
      toolState?: string | null;
      correctedTo?: string | null;
      lastReferenced?: string | null;
    },
  ): Promise<MemoryUpdateResult> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const normalizedOldText = normalizeMemoryLookupText(oldText);
      if (!normalizedOldText) return { matched: 0, updated: 0, entries: [] };
      const params: unknown[] = [];
      const conditions = buildScopeConditions(params, updates.target, updates.project ?? undefined);
      conditions.push(`content LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikePattern(normalizedOldText)}%`);

      const rows = this.db.prepare(`
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY id ASC
      `).all(...params) as MemoryRow[];

      if (rows.length === 0) {
        return { matched: 0, updated: 0, entries: [] };
      }

      const nextLastReferenced = updates.lastReferenced?.trim() || today();

      for (const row of rows) {
        this.db.prepare(`
          UPDATE memories
          SET content = ?,
              category = ?,
              failure_reason = ?,
              tool_state = ?,
              corrected_to = ?,
              last_referenced = ?
          WHERE id = ?
        `).run(
          updates.content.trim(),
          updates.category === undefined ? row.category : updates.category,
          updates.failureReason === undefined ? row.failure_reason : normalizeNullable(updates.failureReason),
          updates.toolState === undefined ? row.tool_state : normalizeNullable(updates.toolState),
          updates.correctedTo === undefined ? row.corrected_to : normalizeNullable(updates.correctedTo),
          nextLastReferenced,
          row.id,
        );
      }

      return {
        matched: rows.length,
        updated: rows.length,
        entries: rows
          .map((row) => this.getMemoryById(row.id))
          .filter((entry): entry is MemoryEntry => entry !== null),
      };
    }));
  }

  async removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const normalizedOldText = normalizeMemoryLookupText(oldText);
      if (!normalizedOldText) return { matched: 0, removed: 0 };
      const params: unknown[] = [];
      const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
      conditions.push(`content LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikePattern(normalizedOldText)}%`);

      const matchingIds = this.db.prepare(`
        SELECT id
        FROM memories
        WHERE ${conditions.join(" AND ")}
      `).all(...params) as Array<{ id: number }>;

      if (matchingIds.length === 0) {
        return { matched: 0, removed: 0 };
      }

      const deleteParams = matchingIds.map((row) => row.id);
      const placeholders = deleteParams.map(() => "?").join(", ");
      const result = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

      return {
        matched: matchingIds.length,
        removed: result.changes,
      };
    }));
  }

  async removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const params: unknown[] = [];
      const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
      conditions.push("content = ?");
      params.push(content.trim());

      const matchingIds = this.db.prepare(`
        SELECT id
        FROM memories
        WHERE ${conditions.join(" AND ")}
      `).all(...params) as Array<{ id: number }>;

      if (matchingIds.length === 0) {
        return { matched: 0, removed: 0 };
      }

      const deleteParams = matchingIds.map((row) => row.id);
      const placeholders = deleteParams.map(() => "?").join(", ");
      const result = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

      return {
        matched: matchingIds.length,
        removed: result.changes,
      };
    }));
  }

  async searchMemories(query: string, options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      if (query.trim().length === 0) {
        return [];
      }

      const { project, target, category, limit = 10, includeSuperseded = false } = options;

      // FTS5 match via subquery with escaped query
      const normalizedQuery = normalizeFts5Query(query);
      if (normalizedQuery.length === 0) {
        return [];
      }

      const runSearch = (matchQuery: string): MemoryEntry[] => {
        const conditions: string[] = [];
        const params: unknown[] = [];

        conditions.push("m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)");
        params.push(matchQuery);

        // Supersession UX: hide superseded entries unless the caller opts in.
        if (!includeSuperseded) {
          conditions.push("m.status = 'active'");
        }

        if (project !== undefined) {
          if (project === null) {
            conditions.push("m.project IS NULL");
          } else {
            conditions.push("m.project = ?");
            params.push(project);
          }
        }

        if (target) {
          conditions.push("m.target = ?");
          params.push(target);
        }

        if (category) {
          conditions.push("m.category = ?");
          params.push(category);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const sql = `
          SELECT ${MEMORY_SELECT_COLUMNS}
          FROM memories m
          ${whereClause}
          ORDER BY m.last_referenced DESC
          LIMIT ?
        `;

        try {
          const rows = this.db.prepare(sql).all(...params, limit) as MemoryRow[];
          return rows.map(mapRow);
        } catch (err) {
          if (isFts5QueryError(err)) {
            return [];
          }
          throw err;
        }
      };

      const exactResults = runSearch(normalizedQuery);
      let lexicalResults = exactResults;
      if (lexicalResults.length === 0) {
        const fallbackQuery = buildFallbackFts5Query(query);
        if (fallbackQuery && fallbackQuery !== normalizedQuery) {
          lexicalResults = runSearch(fallbackQuery);
        }
      }
      if (lexicalResults.length === 0) {
        return []; // no lexical seeds → no graph recall
      }

      const neighbors = this.fetchGraphNeighbors(lexicalResults, { project, target, category, includeSuperseded });
      if (neighbors.length === 0) {
        // Close the no-neighbor fast path: route single-match / no-shared-
        // neighbor searches through the shared ranker so the worth multiplier
        // applies (instead of raw last_referenced DESC). Neighbors stay empty
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
    }));
  }

  /**
   * Fetch graph neighbors: memories sharing any implicit tag (project/category/
   * target) with the seed set, excluding the seeds, within the same search
   * scope, capped. Augments lexical search results for the shared ranker.
   * SQLite mirrors the SurrealDB RELATE graph via column equality — no schema
   * change.
   */
  private fetchGraphNeighbors(
    seeds: MemoryEntry[],
    scope: { project?: string | null; target?: MemoryTarget; category?: MemoryCategory; includeSuperseded?: boolean },
  ): MemoryEntry[] {
    const seedIds = seeds.map((m) => m.id);
    const projects = [...new Set(seeds.map((m) => m.project).filter((v): v is string => v != null))];
    const categories = [...new Set(seeds.map((m) => m.category).filter((v): v is MemoryCategory => v != null))];
    const targets = [...new Set(seeds.map((m) => m.target).filter((v): v is MemoryTarget => v != null))];

    if (projects.length === 0 && categories.length === 0 && targets.length === 0) {
      return [];
    }

    const conditions: string[] = [`m.id NOT IN (${seedIds.map(() => "?").join(", ")})`];
    const params: unknown[] = [...seedIds];

    const orClauses: string[] = [];
    if (projects.length > 0) {
      orClauses.push(`m.project IN (${projects.map(() => "?").join(", ")})`);
      params.push(...projects);
    }
    if (categories.length > 0) {
      orClauses.push(`m.category IN (${categories.map(() => "?").join(", ")})`);
      params.push(...categories);
    }
    if (targets.length > 0) {
      orClauses.push(`m.target IN (${targets.map(() => "?").join(", ")})`);
      params.push(...targets);
    }
    conditions.push(`(${orClauses.join(" OR ")})`);

    if (scope.project !== undefined) {
      if (scope.project === null) {
        conditions.push("m.project IS NULL");
      } else {
        conditions.push("m.project = ?");
        params.push(scope.project);
      }
    }
    if (scope.target) {
      conditions.push("m.target = ?");
      params.push(scope.target);
    }
    if (scope.category) {
      conditions.push("m.category = ?");
      params.push(scope.category);
    }

    // Mirror runSearch: superseded neighbors are hidden unless opted in.
    if (!scope.includeSuperseded) {
      conditions.push("m.status = 'active'");
    }

    const sql = `
      SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories m
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.last_referenced DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, GRAPH_NEIGHBOR_CAP) as MemoryRow[];
    return rows.map(mapRow);
  }

  async getMemories(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const { project, target, category } = options;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (project !== undefined) {
        if (project === null) {
          conditions.push("project IS NULL");
        } else {
          conditions.push("project = ?");
          params.push(project);
        }
      }

      if (target) {
        conditions.push("target = ?");
        params.push(target);
      }

      if (category) {
        conditions.push("category = ?");
        params.push(category);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const rows = this.db.prepare(`
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
        ${whereClause}
        ORDER BY last_referenced DESC
      `).all(...params) as MemoryRow[];

      return rows.map(mapRow);
    }));
  }

  async getRecentFailures(maxAgeDays = 7, project?: string | null): Promise<MemoryEntry[]> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - maxAgeDays);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const conditions: string[] = ["target = ?", "created >= ?"];
      const params: unknown[] = ["failure", cutoffStr];

      if (project !== undefined) {
        if (project === null) {
          conditions.push("project IS NULL");
        } else {
          conditions.push("(project = ? OR project IS NULL)");
          params.push(project);
        }
      }

      const rows = this.db.prepare(`
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY created DESC
        LIMIT 5
      `).all(...params) as MemoryRow[];

      return rows.map(mapRow);
    }));
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const total = (this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number }).count;

      const byProject = this.db.prepare(`
        SELECT project, COUNT(*) as count
        FROM memories
        GROUP BY project
        ORDER BY count DESC
      `).all() as { project: string | null; count: number }[];

      const byTarget = this.db.prepare(`
        SELECT target, COUNT(*) as count
        FROM memories
        GROUP BY target
        ORDER BY count DESC
      `).all() as { target: string; count: number }[];

      return { total, byProject, byTarget };
    }));
  }

  async removeMemory(id: number): Promise<boolean> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return result.changes > 0;
    }));
  }

  async touchMemory(id: number): Promise<void> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      this.db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run(today(), id);
    }));
  }

  async bumpMemoryWorth(id: number, successDelta = 0, failDelta = 0): Promise<void> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
      this.db.prepare("UPDATE memories SET mw_success = mw_success + ?, mw_fail = mw_fail + ? WHERE id = ?").run(successDelta, failDelta, id);
    }));
  }

  /**
   * Mark `priorId` as superseded by `newId`, and record the reverse lineage on
   * `newId`. Two UPDATEs (NOT delete+insert) so the prior row's id stays
   * stable for any external lineage references. `parent_ids` is stored as a
   * JSON array on the new row. Wrapped in the same recovery+retry envelope as
   * the other mutators.
   */
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() =>
      runExclusive(this.db, () => {
        this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newId, priorId);
        this.db.prepare("UPDATE memories SET supersedes = ?, parent_ids = ? WHERE id = ?").run(priorId, JSON.stringify([priorId]), newId);
      }),
    ));
  }
}
