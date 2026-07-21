/**
 * SqliteMemoryRepository — async, backend-neutral(ish) repository wrapping the
 * SQLite memory store. Ports the free functions of `sqlite-memory-store.ts`
 * into a class that implements `MemoryRepository`.
 *
 * Every public method wraps its body in
 *   `this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => { ... }))`
 * absorbing the corruption-recovery + transient-retry wrappers that today live
 * at call sites. The SQL bodies are copied verbatim from the original free
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

// ---------------------------------------------------------------------------
// Pure helpers (copied verbatim from sqlite-memory-store.ts). These stay as
// module-level exported functions because some non-DB callers (e.g.
// memory-tool.ts) use `formatFailureMemoryContent` / `parseMarkdownMemoryEntry`
// without a DB.
// ---------------------------------------------------------------------------

const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
]);

export function today(): string {
  return new Date().toISOString().split("T")[0];
}

export function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

export function parseMetadataComment(raw: string): { text: string; created: string; lastReferenced: string } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);
  if (match) {
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
    };
  }

  const fallback = today();
  return {
    text: raw.trim(),
    created: fallback,
    lastReferenced: fallback,
  };
}

export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  },
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  if (options.project) parts.push(`Project: ${options.project}`);
  return parts.join(" — ");
}

export interface ParsedMarkdownMemoryEntry {
  content: string;
  target: MemoryTarget;
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
}

export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: MemoryTarget,
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  const { text, created, lastReferenced } = parseMetadataComment(rawEntry);
  const parsedProject = normalizeNullable(project);

  if (target !== "failure") {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
    };
  }

  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(" — ");
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("Failed: ") && !failureReason) {
      failureReason = segment.slice("Failed: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Tool state: ") && !toolState) {
      toolState = segment.slice("Tool state: ".length).trim() || null;
      continue;
    }
    if (segment.startsWith("Corrected to: ") && !correctedTo) {
      correctedTo = segment.slice("Corrected to: ".length).trim() || null;
    }
  }

  return {
    content: text,
    target: "failure",
    project: parsedProject,
    category,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
  };
}

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
  last_referenced
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
};

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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced);

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
      };
    }));
  }

  async syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult> {
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
          };
          const result = this.db.prepare(`
            INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(project, input.target, category, content, failureReason, toolState, correctedTo, created, lastReferenced);
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
      if (query.trim().length === 0) {
        return [];
      }

      const { project, target, category, limit = 10 } = options;

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
      if (exactResults.length > 0) {
        return exactResults;
      }

      const fallbackQuery = buildFallbackFts5Query(query);
      if (!fallbackQuery || fallbackQuery === normalizedQuery) {
        return exactResults;
      }

      return runSearch(fallbackQuery);
    }));
  }

  async getMemories(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
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
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
      const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return result.changes > 0;
    }));
  }

  async touchMemory(id: number): Promise<void> {
    return this.backend.withCorruptionRecovery(() => runWithTransientRetry(() => {
      this.db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run(today(), id);
    }));
  }
}
