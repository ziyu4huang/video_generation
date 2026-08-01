import type { BackendBundle } from "./repository.js";
import type { MemoryConfig } from "../types.js";
import { SqliteBackend } from "./sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "./sqlite/sqlite-memory-repo.js";
import { SqliteSessionRepository } from "./sqlite/sqlite-session-repo.js";
import { SurrealBackend } from "./surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "./surreal/surreal-memory-repo.js";
import { SurrealSessionRepository } from "./surreal/surreal-session-repo.js";

/**
 * Build the backend bundle (Backend + MemoryRepository + SessionRepository)
 * selected by `config.dbBackend` (default `'sqlite'`). The SurrealDB backend
 * targets a local SurrealDB v3 server and is opt-in via `'surrealdb'`.
 */
export async function createBackendBundle(
  config: MemoryConfig,
  memoryDir: string,
): Promise<BackendBundle> {
  switch (config.dbBackend ?? "sqlite") {
    case "sqlite": {
      const backend = new SqliteBackend(memoryDir);
      await backend.init();
      return {
        backend,
        memoryRepo: new SqliteMemoryRepository(backend),
        sessionRepo: new SqliteSessionRepository(backend),
      };
    }
    case "surrealdb": {
      const backend = new SurrealBackend(config.surreal ?? {});
      await backend.init();
      const memoryRepo = new SurrealMemoryRepository(backend);
      // One-time, idempotent: heal legacy random-id rows → memories:<seq> so the
      // graph-edge code (which keys by seq) attaches edges to the real record.
      // When it migrates ≥1 row it also wipes `tagged` (the next call rebuilds it).
      await memoryRepo.normalizeLegacyMemoryIds();
      // Auto-heal `tagged` graph edges for rows written before graph-augmented
      // search shipped. Best-effort (never throws) so it cannot trip the sqlite
      // fallback in createBackendBundleWithFallback. A no-op once every row
      // has edges.
      await memoryRepo.backfillGraphEdges();
      return {
        backend,
        memoryRepo,
        sessionRepo: new SurrealSessionRepository(backend),
      };
    }
  }
}

export interface BackendBundleWithFallback {
  bundle: BackendBundle;
  /** `null` when the configured backend initialized cleanly; `"sqlite"` when
   *  it failed and we fell back to sqlite so agent startup is not blocked. */
  fellBackTo: "sqlite" | null;
}

/**
 * Build the backend bundle like {@link createBackendBundle}, but if the
 * configured backend fails to initialize (e.g. the local SurrealDB server is
 * down/unreachable), fall back to sqlite so a missing external service never
 * blocks agent startup. Returns which backend is actually active via
 * `fellBackTo` so the caller can surface the fallback to the user.
 *
 * sqlite is the floor: if sqlite itself fails there is nothing to fall back
 * to, and the error rethrows (the caller decides whether that is fatal).
 */
export async function createBackendBundleWithFallback(
  config: MemoryConfig,
  memoryDir: string,
): Promise<BackendBundleWithFallback> {
  try {
    const bundle = await createBackendBundle(config, memoryDir);
    return { bundle, fellBackTo: null };
  } catch (err) {
    if ((config.dbBackend ?? "sqlite") === "sqlite") throw err; // sqlite IS the floor
    const bundle = await createBackendBundle({ ...config, dbBackend: "sqlite" }, memoryDir);
    return { bundle, fellBackTo: "sqlite" };
  }
}
