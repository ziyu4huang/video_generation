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
      return {
        backend,
        memoryRepo: new SurrealMemoryRepository(backend),
        sessionRepo: new SurrealSessionRepository(backend),
      };
    }
  }
}
