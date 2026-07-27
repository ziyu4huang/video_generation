/**
 * SurrealClient — minimal HTTP client for a SurrealDB v3 server's /sql
 * endpoint. No external dependency: uses the global `fetch`.
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
 */

import { bumpRoundTrips } from "../../perf.js";

export interface SurrealClientOptions {
  endpoint: string;       // e.g. http://127.0.0.1:8000
  namespace: string;      // e.g. user_<user>
  database: string;       // e.g. memory
  username: string;       // e.g. root
  password: string;       // e.g. root
  fetch?: typeof fetch;   // injectable for tests
  maxAttempts?: number;   // default 3
  backoffMs?: number;     // default 100
  /** Per-request hard timeout (ms). A hung SurrealDB round-trip would otherwise
   *  stall the caller INDEFINITELY (no default fetch timeout). A timeout fires
   *  a clear error and is NOT retried — a stuck server would just multiply the
   *  bound. Default 10000 (a normal round-trip is ~10–50ms). */
  requestTimeoutMs?: number;
}

type StatementResult =
  | { status: "OK"; result: unknown }
  | { status: string; result: unknown };

export class SurrealClient {
  private readonly fetchFn: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly auth: string;

  constructor(private readonly opts: SurrealClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 100;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.auth = "Basic " + btoa(`${opts.username}:${opts.password}`);
  }

  /**
   * Run SQL with optional params; return the last statement's result.
   * Throws on the FIRST non-OK statement in the batch — SurrealDB's /sql
   * endpoint processes each statement in a batch independently, so an
   * early failing statement does NOT halt later ones.
   */
  async query<T = unknown[]>(sql: string, params: Record<string, unknown> = {}): Promise<T> {
    bumpRoundTrips(); // attribute one HTTP round-trip to the active perf op (no-op outside any timed())
    const body = this.buildBody(sql, params);
    const statements = await this.send<StatementResult[]>(body);
    if (statements.length === 0) return [] as unknown as T;
    for (const stmt of statements) {
      if (stmt.status !== "OK") {
        const detail = typeof stmt.result === "string" ? stmt.result : JSON.stringify(stmt.result);
        throw new Error(`SurrealDB error: ${detail}`);
      }
    }
    return statements[statements.length - 1].result as T;
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
      let res: Response;
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
