import type { BackendBundle } from "./repository.js";
import type { MemoryConfig } from "../types.js";
import { SqliteBackend } from "./sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "./sqlite/sqlite-memory-repo.js";
import { SqliteSessionRepository } from "./sqlite/sqlite-session-repo.js";

/**
 * Build the backend bundle (Backend + MemoryRepository + SessionRepository)
 * selected by `config.dbBackend` (default `'sqlite'`). The SurrealDB backend
 * is added in a follow-up plan (Phase 3); until then `'surrealdb'` throws.
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
    case "surrealdb":
      throw new Error("SurrealDB backend is not implemented yet (Phase 3).");
  }
}
