import type { Backend } from "../repository.js";
import type { SurrealConnection } from "../../types.js";
import { SurrealClient, SURREAL_DEFAULTS } from "@repo/s2-agent-core-interface";
import { bumpRoundTrips } from "../../perf.js";
import { SURREAL_BOOTSTRAP_SQL } from "./schema.js";
import { derivePerUserNamespace, DEFAULT_SURREAL_DATABASE } from "./per-user-db.js";

// Client + endpoint/credential defaults live in core-interface (kcard-parity
// D4/D5); the per-user namespace + database name are hermes-owned.
const DEFAULTS: SurrealConnection = {
  ...SURREAL_DEFAULTS,
  namespace: derivePerUserNamespace(),
  database: DEFAULT_SURREAL_DATABASE,
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
      onRoundTrip: bumpRoundTrips, // perf attribution (was a hard import inside the client pre-D4)
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
