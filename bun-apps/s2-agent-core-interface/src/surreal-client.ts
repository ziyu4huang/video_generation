/**
 * SurrealClient — minimal HTTP client for a SurrealDB v3 server's /sql
 * endpoint. No external dependency: uses the global `fetch`.
 *
 * Moved from s2-agent-ext-hermes-memory (kcard-parity D4, ticket 01): both
 * hermes-memory and knowledge-card need a client; core-interface already
 * hosts shared runtime infra (`embedding-leaf.ts`, `seam.ts`). The hermes
 * `bumpRoundTrips` perf hook became the injectable `onRoundTrip` option so
 * the client carries zero consumer coupling.
 *
 * Variable binding is done by prepending `LET $name = <json>;` statements
 * (JSON.stringify is a valid SurrealQL subset for string/number/bool/null/
 * object/array). The caller passes a final SQL statement; query() returns
 * the parsed `result` of the LAST statement in the batch. query() throws
 * on the FIRST non-OK statement in the batch — SurrealDB's /sql endpoint
 * processes each statement independently, so an early failure does NOT
 * halt later statements and must be detected explicitly.
 *
 * Transient retry (connection failure / 5xx / 429) lives here so repository
 * methods just call client.query() and inherit retry. There is no corruption
 * layer — a server has no file-corruption semantics.
 *
 * D5 stance: SurrealDB is an embedded local service, not a standalone
 * server — SURREAL_DEFAULTS is a fixed constant, deliberately with NO
 * env-override leaf. Only flexibility: the injectable `fetch` (tests) and
 * constructor options.
 */

/** Structural fetch contract — deliberately NOT `typeof fetch`, for the same
 *  reason as embedding-leaf's FetchLike: this file is compiled by consumers
 *  whose tsconfigs run DOM-less (lib:["ESNext"] `Response` lacks
 *  ok/status/text/json — ext-entry typecheck broke on krea2/ltx/zai-mcp).
 *  The real global fetch satisfies this shape at runtime; default references
 *  are cast through `unknown` so no program needs DOM types to check us. */
export interface SurrealFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type SurrealFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<SurrealFetchResponse>;

export interface SurrealClientOptions {
  endpoint: string;       // e.g. http://127.0.0.1:8000
  namespace: string;      // e.g. user_<user>
  database: string;       // e.g. memory
  username: string;       // e.g. root
  password: string;       // e.g. root
  fetch?: SurrealFetch;   // injectable for tests
  maxAttempts?: number;   // default 3
  backoffMs?: number;     // default 100
  /** Per-request hard timeout (ms). A hung SurrealDB round-trip would otherwise
   *  stall the caller INDEFINITELY (no default fetch timeout). A timeout fires
   *  a clear error and is NOT retried — a stuck server would just multiply the
   *  bound. Default 10000 (a normal round-trip is ~10–50ms). */
  requestTimeoutMs?: number;
  /** Called once per HTTP round-trip, before the request is sent. Injected by
   *  consumers that attribute round-trips to a perf op (hermes: bumpRoundTrips).
   *  Must not throw — a throwing hook would fail the query itself. */
  onRoundTrip?: () => void;
}

/** Fixed local-service defaults (D5): endpoint + root credentials shared by
 *  every consumer. Namespace/database are per-consumer (hermes: per-user ns +
 *  `memory`; kcard: per-user ns + `context_db`) and are NOT part of this. */
export const SURREAL_DEFAULTS = {
  endpoint: "http://127.0.0.1:8000",
  username: "root",
  password: "root",
} as const;

type StatementResult =
  | { status: "OK"; result: unknown }
  | { status: string; result: unknown };

export class SurrealClient {
  private readonly fetchFn: SurrealFetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly auth: string;
  private readonly onRoundTrip: (() => void) | undefined;

  constructor(private readonly opts: SurrealClientOptions) {
    this.fetchFn = opts.fetch ?? (fetch as unknown as SurrealFetch);
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 100;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.onRoundTrip = opts.onRoundTrip;
    this.auth = "Basic " + btoa(`${opts.username}:${opts.password}`);
  }

  /** The bound namespace/database (kcard-parity ticket 07: consumers like the
   *  kcard index bootstrap `DEFINE NAMESPACE/DATABASE IF NOT EXISTS` against
   *  their own binding — v3 does not lazily create them). */
  get namespace(): string {
    return this.opts.namespace;
  }

  get database(): string {
    return this.opts.database;
  }

  /**
   * Run SQL with optional params; return the last statement's result.
   * Throws on the FIRST non-OK statement in the batch — SurrealDB's /sql
   * endpoint processes each statement in a batch independently, so an
   * early failing statement does NOT halt later ones.
   */
  async query<T = unknown[]>(sql: string, params: Record<string, unknown> = {}): Promise<T> {
    this.onRoundTrip?.(); // attribute one HTTP round-trip to the consumer's perf op
    const body = this.buildBody(sql, params);
    const statements = await this.send<StatementResult[]>(body);
    if (statements.length === 0) return [] as unknown as T;
    for (const stmt of statements) {
      if (stmt.status !== "OK") {
        const detail = typeof stmt.result === "string" ? stmt.result : JSON.stringify(stmt.result);
        throw new Error(`SurrealDB error: ${detail}`);
      }
    }
    return statements.at(-1)!.result as T;
  }

  private buildBody(sql: string, params: Record<string, unknown>): string {
    const lets = Object.entries(params)
      .map(([k, v]) => `LET $${k} = ${JSON.stringify(v)};`)
      .join("\n");
    return lets.length > 0 ? `${lets}\n${sql}` : sql;
  }

  private isRetryableStatus(status: number): boolean {
    return status >= 500 || status === 429;
  }

  private async send<T>(body: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: SurrealFetchResponse;
      try {
        res = await this.fetchFn(`${this.opts.endpoint}/sql`, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "Accept": "application/json",
            "surreal-ns": this.opts.namespace,
            "surreal-db": this.opts.database,
            "Authorization": this.auth,
          },
          body,
          // Hard per-request bound. AbortSignal.timeout fires a DOMException
          // (name "TimeoutError"/"AbortError") that the catch below turns into
          // a fail-fast timeout error — NOT retried (see catch).
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        // Per-request timeout: the server is stuck. Fail fast rather than
        // retrying (a retry would just multiply the bound). A genuine timeout
        // is not a transient blip the retry loop exists to absorb.
        if (err instanceof Error && /timeout/i.test(err.name)) {
          throw new Error(`SurrealDB request timeout after ${this.requestTimeoutMs}ms`);
        }
        lastErr = err;
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs * attempt);
          continue;
        }
        throw new Error(`SurrealDB request failed: ${this.errMsg(err)}`);
      }
      if (this.isRetryableStatus(res.status) && attempt < this.maxAttempts) {
        await this.sleep(this.backoffMs * attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SurrealDB HTTP ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`SurrealDB request failed after ${this.maxAttempts} attempts: ${this.errMsg(lastErr)}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
