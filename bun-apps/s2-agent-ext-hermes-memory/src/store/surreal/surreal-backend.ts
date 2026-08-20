import type { Backend } from "../repository.js";
import type { SurrealConnection } from "../../types.js";
import { SurrealClient } from "./surreal-client.js";
import { SURREAL_BOOTSTRAP_SQL } from "./schema.js";
import { derivePerUserNamespace, DEFAULT_SURREAL_DATABASE } from "./per-user-db.js";

const DEFAULTS: SurrealConnection = {
  endpoint: "http://127.0.0.1:8000",
  namespace: derivePerUserNamespace(),
  database: DEFAULT_SURREAL_DATABASE,
  username: "root",
  password: "root",
};

/**
 * SurrealDB backend. HTTP/stateless: no connection pool, no WAL, no
 * corruption self-heal (those are SQLite file semantics). Retry lives inside
 * SurrealClient. The two repositories share `client`.
 */
export class SurrealBackend implements Backend {
  readonly client: SurrealClient;
  private readonly ns: string;
  private readonly db: string;

  constructor(conn: Partial<SurrealConnection> = {}) {
    const merged = { ...DEFAULTS, ...conn };
    this.ns = merged.namespace;
    this.db = merged.database;
    this.client = new SurrealClient({
      endpoint: merged.endpoint,
      namespace: merged.namespace,
      database: merged.database,
      username: merged.username,
      password: merged.password,
    });
  }

  async init(): Promise<void> {
    await this.client.query(SURREAL_BOOTSTRAP_SQL(this.ns, this.db));
  }

  async healthCheck(): Promise<void> {
    // SurrealQL v3 has no bare `SELECT 1` — `RETURN 1` is the canonical
    // "ping" statement (a single-expression query that round-trips a value).
    await this.client.query("RETURN 1;");
  }

  /** HTTP is stateless — nothing to close. Kept for interface symmetry. */
  async close(): Promise<void> {
    // no-op
  }
}
