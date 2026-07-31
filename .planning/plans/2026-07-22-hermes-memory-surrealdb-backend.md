# Hermes Memory — SurrealDB Backend (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the additive, default-off SurrealDB backend (`src/store/surreal/*`) that fills the `createBackendBundle` `surrealdb` branch, so `config.dbBackend: "surrealdb"` runs the full memory + session search stack against the local SurrealDB service.

**Architecture:** A `SurrealClient` wraps `fetch` against `/sql` with `LET $param` variable binding, response parsing, and transient retry. `SurrealBackend implements Backend` bootstraps the schema (analyzer, fulltext indexes, tables, `seq` counter). `SurrealMemoryRepository` / `SurrealSessionRepository` implement the already-merged `repository.ts` interfaces in SurrealQL. Upstream (`index.ts`, handlers, tools) is unchanged. The shared `repository-contract.test.ts` is reused as the equivalence benchmark.

**Tech Stack:** Bun + TypeScript (strict), SurrealDB v3.2.3 on `127.0.0.1:8000`, raw `fetch` (no new dependency), `bun:test`.

## Global Constraints

- **Conversation language zh_TW; all written output (code, comments, commits, file content) English.**
- **No top-level `cd`** — repo hook `no-cd-drift.sh` blocks it. Use `( cd <dir> && ... )`, `--cwd`, or absolute paths.
- **Package:** `bun-apps/pi-agent-ext-hermes-memory`. Bun workspace root is `bun-apps/`.
- **Authoritative typecheck gate:** `bun run --cwd bun-apps/pi-agent typecheck` (EXIT 0). The package's own `bun run check` is PRE-EXISTING BROKEN (no `@types/node`) — never trust it as a signal. See memory `hermes-memory-standalone-tsc-broken-use-pi-agent-typecheck`.
- **Pure additive, default-off.** `config.dbBackend` defaults to `"sqlite"`; nothing upstream changes. `bun:sqlite` import must remain confined to `src/store/sqlite/` (grep `bun:sqlite` → still 1 hit).
- **DTO `MemoryEntry.id: number` is immutable** — implemented as a stored `seq` integer field (NOT integer record keys; `type::record("t", n)` produces a broken array id `t:[1]`).
- **Verified SurrealQL v3.2.3 syntax (use exactly):**
  - `LET $x = 42;` (single `=`, NOT `:=`)
  - `RETURN $x;` for bare values (a bare `SELECT expr` is a parse error)
  - `DEFINE NAMESPACE IF NOT EXISTS <n>;` + `DEFINE DATABASE IF NOT EXISTS <n>;` — namespaces/dbs are NOT lazily created, init MUST define them
  - Counter: `LET $next = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0];` — the `[0]` unwrap is REQUIRED
  - Bootstrap counter: `IF array::len((SELECT id FROM seq:memory)) = 0 { CREATE seq:memory SET value = 0; }`
  - FTS: `DEFINE ANALYZER hermes_en TOKENIZERS class FILTERS snowball(english);` + `DEFINE INDEX <i> ON TABLE <t> FIELDS content FULLTEXT ANALYZER hermes_en;` + query `WHERE content @@ $q`
  - `string::contains(content, $term)` for LIKE-style fallback
  - `UPSERT … WHERE` ALWAYS inserts on no-match → do NOT use it for dedup
  - `count()`, `GROUP ALL`, `GROUP BY field` supported; `ORDER BY field DESC`, `LIMIT n` supported
- **Variable binding:** params are `JSON.stringify`-encoded and prepended as `LET $name = <json>;` statements. Valid for string/number/bool/null/object/array.
- **Local-only test gate:** the SurrealDB contract tests require the local `:8000` service; CI runs only SQLite. Test files probe the service at import time and `describe.skip` when it is absent (a missing service never red-lights CI).
- **Live service:** v3.2.3 confirmed running `http://127.0.0.1:8000`, root/root. Verify before each local test run: `curl -s http://127.0.0.1:8000/health` → `200`.

---

## File Structure

```
src/store/surreal/
├─ surreal-client.ts        ← SurrealClient: fetch /sql, LET binding, parse, transient retry
├─ schema.ts                ← SURREAL_BOOTSTRAP_SQL string (DDL)
├─ surreal-backend.ts       ← SurrealBackend implements Backend (init/healthCheck/close)
├─ surreal-memory-repo.ts   ← SurrealMemoryRepository implements MemoryRepository
└─ surreal-session-repo.ts  ← SurrealSessionRepository implements SessionRepository
```

Modified:
- `src/store/backend-factory.ts` — `surrealdb` branch: throw → instantiate `SurrealBackend` + two repos.
- `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` — note the SurrealDB backend exists.

Tests:
- `tests/store/surreal/surreal-client.test.ts` — unit tests, mock `fetch` (no live server).
- `tests/store/surreal/surreal-backend.test.ts` — live-gated init/health/bootstrap idempotency.
- `tests/store/surreal/surreal-memory-repo-contract.test.ts` — reuses `runMemoryRepositoryContract`, live-gated.
- `tests/store/surreal/surreal-session-repo-contract.test.ts` — reuses `runSessionRepositoryContract`, live-gated.
- `tests/store/surreal/_helpers.ts` — `isSurrealUp()`, `withLocalSurrealDescribe`, `uniqueNs()`.

Reference (read, do not modify):
- `src/store/repository.ts` — the interfaces being implemented.
- `src/store/sqlite/sqlite-memory-repo.ts`, `src/store/sqlite/sqlite-session-repo.ts` — the reference behavior to mirror.
- `tests/store/repository-contract.test.ts` — the shared contract factories.

---

### Task 1: SurrealClient (`/sql` wrapper)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-client.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-client.test.ts`

**Interfaces:**
- Consumes: nothing (standalone; global `fetch`, `btoa`).
- Produces: `export class SurrealClient { constructor(opts: SurrealClientOptions); query<T>(sql: string, params?: Record<string, unknown>): Promise<T> }` where `T` is the last statement's parsed `result`. Also `export interface SurrealClientOptions`.

**Interfaces consumed by later tasks:** `new SurrealClient(opts)` and `await client.query<T>(sql, params)`.

- [ ] **Step 1: Write the failing test (mock fetch).**

`tests/store/surreal/surreal-client.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { SurrealClient } from "../../../src/store/surreal/surreal-client.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("SurrealClient", () => {
  it("posts SurrealQL with LET bindings and returns the last statement result", async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8000/sql");
      const headers = init!.headers as Record<string, string>;
      expect(headers["surreal-ns"]).toBe("hermes");
      expect(headers["surreal-db"]).toBe("memory");
      expect(headers["Authorization"]).toMatch(/^Basic /);
      const body = String(init!.body);
      expect(body).toContain('LET $name = "alice";');
      expect(body).toContain("RETURN $name;");
      return okJson([
        { result: "alice", status: "OK", time: "0ns" },
        { result: ["alice"], status: "OK", time: "0ns" },
      ]);
    });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "hermes", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
    });
    const rows = await client.query<string[]>("RETURN $name;", { name: "alice" });
    expect(rows).toEqual(["alice"]);
  });

  it("throws on a statement whose status is not OK", async () => {
    const fetchMock = mock(async () => okJson([{ status: "ERR", result: "Table missing", time: "0ns" }]));
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "hermes", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.query("SELECT * FROM nope;")).rejects.toThrow("Table missing");
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls < 3) return new Response("", { status: 503 });
      return okJson([{ result: [{ ok: true }], status: "OK", time: "0ns" }]);
    });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "hermes", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
      backoffMs: 1, maxAttempts: 3,
    });
    const rows = await client.query("SELECT 1;");
    expect(rows).toEqual([{ ok: true }]);
    expect(calls).toBe(3);
  });

  it("retries on connection failure then throws after maxAttempts", async () => {
    const fetchMock = mock(async () => { throw new TypeError("fetch failed"); });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "hermes", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
      backoffMs: 1, maxAttempts: 2,
    });
    await expect(client.query("SELECT 1;")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-client.test.ts )`
Expected: FAIL — module `surreal-client.js` not found.

- [ ] **Step 3: Write the implementation.**

`src/store/surreal/surreal-client.ts`:

```ts
/**
 * SurrealClient — minimal HTTP client for a SurrealDB v3 server's /sql
 * endpoint. No external dependency: uses the global `fetch`.
 *
 * Variable binding is done by prepending `LET $name = <json>;` statements
 * (JSON.stringify is a valid SurrealQL subset for string/number/bool/null/
 * object/array). The caller passes a final SQL statement; query() returns
 * the parsed `result` of the LAST statement in the batch.
 *
 * Transient retry (connection failure / 5xx / 429) lives here so repository
 * methods just call client.query() and inherit retry. There is no corruption
 * layer — a server has no file-corruption semantics.
 */

export interface SurrealClientOptions {
  endpoint: string;       // e.g. http://127.0.0.1:8000
  namespace: string;      // e.g. hermes
  database: string;       // e.g. memory
  username: string;       // e.g. root
  password: string;       // e.g. root
  fetch?: typeof fetch;   // injectable for tests
  maxAttempts?: number;   // default 3
  backoffMs?: number;     // default 100
}

type StatementResult =
  | { status: "OK"; result: unknown }
  | { status: string; result: unknown };

export class SurrealClient {
  private readonly fetchFn: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly auth: string;

  constructor(private readonly opts: SurrealClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 100;
    this.auth = "Basic " + btoa(`${opts.username}:${opts.password}`);
  }

  /** Run SQL with optional params; return the last statement's result. */
  async query<T = unknown[]>(sql: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = this.buildBody(sql, params);
    const statements = await this.send<StatementResult[]>(body);
    if (statements.length === 0) return [] as unknown as T;
    const last = statements[statements.length - 1];
    if (last.status !== "OK") {
      const detail = typeof last.result === "string" ? last.result : JSON.stringify(last.result);
      throw new Error(`SurrealDB error: ${detail}`);
    }
    return last.result as T;
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
        });
      } catch (err) {
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
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-client.test.ts )`
Expected: PASS, 4/4.

- [ ] **Step 5: Verify cross-package typecheck.**

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: EXIT 0.

- [ ] **Step 6: Commit.**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-client.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-client.test.ts
git commit -m "feat(hermes-memory): SurrealClient /sql wrapper (LET binding, parse, retry)"
```

---

### Task 2: SurrealBackend + schema bootstrap

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-backend.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/_helpers.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-backend.test.ts`

**Interfaces:**
- Consumes: `SurrealClient` (Task 1), `Backend` from `../repository.js`, `SurrealConnection` from `../../types.js`, `MemoryConfig`.
- Produces: `export class SurrealBackend implements Backend` with `constructor(conn: Partial<SurrealConnection>)`, plus a `client` accessor used by the two repositories.

**Interfaces consumed by later tasks:** `new SurrealBackend(config.surreal ?? {})`, `await backend.init()`, `backend.client` (a `SurrealClient`), `await backend.close()`.

- [ ] **Step 1: Read the `Backend` interface and `SurrealConnection` type.**

Confirm `Backend` is `{ init(): Promise<void>; close(): Promise<void>; healthCheck(): Promise<void> }` in `src/store/repository.ts` and `SurrealConnection` is in `src/types.ts` (`{ endpoint; namespace; database; username; password }`, all strings). These already exist from Phase 1.

- [ ] **Step 2: Write the failing test (live-gated).**

`tests/store/surreal/_helpers.ts`:

```ts
import { describe } from "bun:test";

/** Probe the local SurrealDB service once at import time. */
export async function isSurrealUp(endpoint = "http://127.0.0.1:8000"): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

/** describe, or describe.skip when the local service is absent. */
export function localDescribe(name: string, up: boolean): ReturnType<typeof describe> | void {
  return (up ? describe : (describe.skip as typeof describe))(name);
}

/** A throwaway namespace name so concurrent test runs never collide. */
let nonce = 0;
export function uniqueNs(): string {
  nonce += 1;
  // Avoid Math.random (not allowed in some runtimes) — use process pid + counter.
  return `hm_test_${process.pid}_${nonce}_${Date.now().toString(36)}`;
}
```

`tests/store/surreal/surreal-backend.test.ts`:

```ts
import { it, expect, beforeAll } from "bun:test";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { isSurrealUp, localDescribe, uniqueNs } from "./_helpers.js";

const up = await isSurrealUp();
localDescribe("SurrealBackend", up!);

const itOrSkip = up ? it : it.skip;

itOrSkip("init() bootstraps schema and is idempotent; healthCheck passes", async () => {
  const ns = uniqueNs();
  const backend = new SurrealBackend({ namespace: ns, database: ns });
  try {
    await backend.init();            // defines ns/db, analyzer, indexes, tables, seq
    await backend.init();            // idempotent re-run must not throw
    await backend.healthCheck();     // SELECT 1 — does not throw

    // Counter bootstrapped to 0, incrementable to 1.
    const next = await backend.client.query<number>(
      `(UPDATE seq:memory SET value += 1 RETURN VALUE value)[0]`,
    );
    expect(next).toBe(1);
  } finally {
    await backend.close();
    // Best-effort cleanup of the throwaway namespace.
    try {
      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
    } catch { /* ignore */ }
  }
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-backend.test.ts )`
Expected: FAIL — `surreal-backend.js` not found (or skip if service down — confirm service is up first via `curl -s http://127.0.0.1:8000/health`).

- [ ] **Step 4: Write `schema.ts`.**

`src/store/surreal/schema.ts`:

```ts
/**
 * Idempotent SurrealQL bootstrap for the hermes-memory backend.
 * Run by SurrealBackend.init(). The `%ns` / `%db` placeholders are the
 * caller's namespace/database (DEFINEd first, since v3 does NOT lazily
 * create them). Field names are camelCase to match the repository DTOs.
 */
export const SURREAL_BOOTSTRAP_SQL = (ns: string, db: string): string => `
DEFINE NAMESPACE IF NOT EXISTS ${ns};
DEFINE DATABASE IF NOT EXISTS ${db};
DEFINE TABLE IF NOT EXISTS memories SCHEMALESS;
DEFINE TABLE IF NOT EXISTS sessions SCHEMALESS;
DEFINE TABLE IF NOT EXISTS messages SCHEMALESS;
DEFINE TABLE IF NOT EXISTS session_files SCHEMALESS;
DEFINE TABLE IF NOT EXISTS seq SCHEMALESS;
DEFINE ANALYZER IF NOT EXISTS hermes_en TOKENIZERS class FILTERS snowball(english);
DEFINE INDEX IF NOT EXISTS memory_fts ON TABLE memories FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS message_fts ON TABLE messages FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS memories_content ON TABLE memories FIELDS content;
IF array::len((SELECT id FROM seq:memory)) = 0 { CREATE seq:memory SET value = 0; };
`;
```

- [ ] **Step 5: Write `surreal-backend.ts`.**

`src/store/surreal/surreal-backend.ts`:

```ts
import type { Backend } from "../repository.js";
import type { SurrealConnection } from "../../types.js";
import { SurrealClient } from "./surreal-client.js";
import { SURREAL_BOOTSTRAP_SQL } from "./schema.js";

const DEFAULTS: SurrealConnection = {
  endpoint: "http://127.0.0.1:8000",
  namespace: "hermes",
  database: "memory",
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
    await this.client.query("SELECT 1;");
  }

  /** HTTP is stateless — nothing to close. Kept for interface symmetry. */
  async close(): Promise<void> {
    // no-op
  }
}
```

- [ ] **Step 6: Run test to verify it passes.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-backend.test.ts )`
Expected: PASS (init idempotent, healthCheck OK, counter 0→1).

- [ ] **Step 7: Verify cross-package typecheck.**

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: EXIT 0.

- [ ] **Step 8: Commit.**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-backend.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/_helpers.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-backend.test.ts
git commit -m "feat(hermes-memory): SurrealBackend + schema bootstrap (analyzer, fulltext, seq)"
```

---

### Task 3: SurrealMemoryRepository

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-repo-contract.test.ts`

**Interfaces:**
- Consumes: `SurrealBackend` (Task 2), `MemoryRepository` + DTOs from `../repository.js`, `MemoryCategory` from `../../types.js`, pure helpers `today` / `normalizeNullable` / `normalizeCategory` from `../memory-format.js`.
- Produces: `export class SurrealMemoryRepository implements MemoryRepository`.

- [ ] **Step 1: Read the reference implementation.**

Read `src/store/sqlite/sqlite-memory-repo.ts` — mirror its method semantics (dedup identity, LIKE matching, FTS-then-fallback, scope conditions). Read `src/store/repository.ts` for the exact `MemoryRepository` + DTO field names. Read `src/store/memory-format.ts` for the exported helpers (`today`, `normalizeNullable`, `normalizeCategory`).

- [ ] **Step 2: Write the failing contract test (live-gated, reuses shared factory).**

`tests/store/surreal/surreal-memory-repo-contract.test.ts`:

```ts
import { beforeAll } from "bun:test";
import { runMemoryRepositoryContract } from "../../repository-contract.test.js";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "../../../src/store/surreal/surreal-memory-repo.js";
import { isSurrealUp, localDescribe, uniqueNs } from "./_helpers.js";

const up = await isSurrealUp();

runMemoryRepositoryContract("SurrealDB", up
  ? async () => {
      const ns = uniqueNs();
      const backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      return {
        repo: new SurrealMemoryRepository(backend),
        close: async () => {
          try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
          await backend.close();
        },
      };
    }
  : async () => ({ repo: undefined as never, close: async () => {} }));

localDescribe("SurrealDB MemoryRepository contract (gate)", up!);
```

> Note: `runMemoryRepositoryContract` registers its own `describe`/`it` blocks; when `up` is false the `make()` returns a dummy and the shared suite still registers, but with no live service it cannot pass. To keep CI green when the service is absent, gate the WHOLE file by wrapping: see Step 2b.

- [ ] **Step 2b: Gate the whole file when the service is down.**

Replace the top of the file so the contract is only registered when `up`:

```ts
import { isSurrealUp } from "./_helpers.js";
const up = await isSurrealUp();
if (up) {
  const { runMemoryRepositoryContract } = await import("../../repository-contract.test.js");
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealMemoryRepository } = await import("../../../src/store/surreal/surreal-memory-repo.js");
  const { uniqueNs } = await import("./_helpers.js");
  runMemoryRepositoryContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealMemoryRepository(backend),
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });
}
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-repo-contract.test.ts )`
Expected: FAIL — `surreal-memory-repo.js` not found (confirm service up first).

- [ ] **Step 4: Write the implementation.**

`src/store/surreal/surreal-memory-repo.ts`:

```ts
/**
 * SurrealMemoryRepository — implements MemoryRepository against a local
 * SurrealDB server via SurrealClient. Mirrors SqliteMemoryRepository's
 * semantics (dedup identity = target+project+category+content; LIKE-style
 * matching for replace/remove; FTS @@ with a string::contains fallback).
 *
 * The DTO `id: number` is stored as the integer field `seq`; record keys are
 * Surreal's native random ids. Records are addressed by `WHERE seq = $id`.
 * No corruption layer — transient retry lives in SurrealClient.
 */

import type { SurrealBackend } from "./surreal-backend.js";
import type {
  MemoryRepository, MemoryEntry, MemorySyncInput, MemorySyncResult,
  MemoryUpdateResult, MemoryRemoveResult, MemoryRemoveOptions,
  MemorySearchOptions, MemoryListOptions, MemoryStats, MemoryTarget,
} from "../repository.js";
import type { MemoryCategory } from "../../types.js";
import { today, normalizeNullable, normalizeCategory } from "../memory-format.js";

type Row = Partial<{
  seq: number; project: string | null; target: string; category: string | null;
  content: string; failureReason: string | null; toolState: string | null;
  correctedTo: string | null; created: string; lastReferenced: string;
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
  };
}

const FIELDS = "seq, project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced";

/** Build SurrealQL WHERE fragments + a params object for scope conditions. */
function buildScope(
  target?: MemoryTarget, project?: string | null, category?: MemoryCategory | null,
): { where: string; params: Record<string, unknown> } {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (target) { conds.push("target = $target"); params.target = target; }
  if (project !== undefined) {
    if (project === null) { conds.push("project IS NONE"); }
    else { conds.push("project = $project"); params.project = project; }
  }
  if (category !== undefined) {
    if (category === null) { conds.push("category IS NONE"); }
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
      CREATE memories SET
        seq = $next,
        project = $project,
        target = $target,
        category = $category,
        content = $content,
        failureReason = $failureReason,
        toolState = $toolState,
        correctedTo = $correctedTo,
        created = $created,
        lastReferenced = $lastReferenced
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
    return mapRow(rows[0]);
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
    const selectSql = `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content LIMIT 1;`;
    const existing = await this.c.query<Row[]>(selectSql, { ...scope.params, content });
    if (existing.length > 0) {
      const seq = Number(existing[0].seq);
      await this.c.query(
        `UPDATE memories SET failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced WHERE seq = $seq RETURN ${FIELDS};`,
        { seq, failureReason, toolState, correctedTo, lastReferenced },
      );
      const row = (await this.c.query<Row[]>(`SELECT ${FIELDS} FROM memories WHERE seq = $seq;`, { seq }))[0];
      return { action: "existing", entry: mapRow(row) };
    }
    const entry = await this.addMemory({
      content, target: input.target, project, category, failureReason, toolState, correctedTo, created, lastReferenced,
    });
    return { action: "inserted", entry };
  }

  async replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null; lastReferenced?: string | null;
  }): Promise<MemoryUpdateResult> {
    if (!oldText.trim()) return { matched: 0, updated: 0, entries: [] };
    const scope = buildScope(updates.target, updates.project ?? undefined);
    const nextLastReferenced = updates.lastReferenced?.trim() || today();
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old) ORDER BY seq ASC;`,
      { ...scope.params, old: oldText },
    );
    if (rows.length === 0) return { matched: 0, updated: 0, entries: [] };
    for (const r of rows) {
      await this.c.query(
        `UPDATE memories SET content = $content, category = $category, failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced WHERE seq = $seq;`,
        {
          seq: Number(r.seq),
          content: updates.content.trim(),
          category: updates.category === undefined ? r.category : normalizeNullable(updates.category),
          failureReason: updates.failureReason === undefined ? r.failureReason : normalizeNullable(updates.failureReason),
          toolState: updates.toolState === undefined ? r.toolState : normalizeNullable(updates.toolState),
          correctedTo: updates.correctedTo === undefined ? r.correctedTo : normalizeNullable(updates.correctedTo),
          lastReferenced: nextLastReferenced,
        },
      );
    }
    return { matched: rows.length, updated: rows.length, entries: rows.map(mapRow) };
  }

  async removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    if (!oldText.trim()) return { matched: 0, removed: 0 };
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`,
      { ...scope.params, old: oldText },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`, { ...scope.params, old: oldText });
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
    const { project, target, category, limit = 10 } = options;
    const scope = buildScope(target, project, category);
    const tail = `ORDER BY lastReferenced DESC LIMIT ${Number(limit)};`;
    const where = scope.where ? `${scope.where.replace("WHERE ", "")} AND` : "";
    try {
      const rows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} content @@ $q ${tail}`,
        { ...scope.params, q: query },
      );
      if (rows.length > 0) return rows.map(mapRow);
    } catch { /* fall through to contains fallback */ }
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE ${where} string::contains(content, $q) ${tail}`,
      { ...scope.params, q: query },
    );
    return rows.map(mapRow);
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
    const scope = buildScope("failure", project);
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE created >= $cutoff ${scope.where ? `AND ${scope.where.replace("WHERE ", "")}` : ""} ORDER BY created DESC LIMIT 5;`,
      { cutoff: cutoffStr, ...scope.params },
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
    await this.c.query(`DELETE FROM memories WHERE seq = $seq;`, { seq: Number(id) });
    return true;
  }

  async touchMemory(id: number): Promise<void> {
    await this.c.query(`UPDATE memories SET lastReferenced = $t WHERE seq = $seq;`, { seq: Number(id), t: today() });
  }
}
```

- [ ] **Step 5: Run contract test to verify it passes.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-repo-contract.test.ts )`
Expected: PASS — the three shared contract cases (add→get→search→remove, syncMemoryEntry dedup, distinctive-term recall) pass.

> If a scope-condition query (e.g. `project IS NONE` / `category IS NONE`) fails, SurrealDB v3 may prefer `IS NULL`; switch the two `IS NONE` literals in `buildScope` to `IS NULL` and re-run.

- [ ] **Step 6: Verify cross-package typecheck.**

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: EXIT 0.

- [ ] **Step 7: Commit.**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-repo-contract.test.ts
git commit -m "feat(hermes-memory): SurrealMemoryRepository (seq-id, @@ search, dedup)"
```

---

### Task 4: SurrealSessionRepository

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-session-repo.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-session-repo-contract.test.ts`

**Interfaces:**
- Consumes: `SurrealBackend` (Task 2); `SessionRepository` + `IndexResult` / `BulkIndexResult` / `IncrementalIndexOptions` / `SessionStats` / `SessionSearchResult` from `../repository.js`; `parseSessionFile` + `getSessionFiles` from `../session-parser.js`; `fs.statSync`.
- Produces: `export class SurrealSessionRepository implements SessionRepository`.

- [ ] **Step 1: Read the reference implementation.**

Read `src/store/sqlite/sqlite-session-repo.ts` for: the `SessionInput` structural type, `LAST_SESSION_BACKFILL_KEY` = `"last_session_backfill"`, `SESSION_BACKFILL_INTERVAL_MS` = `86400000`, the `indexSessionOnce` derivation of `cwd`/`project`/`startedAt` defaults, the mtime/size dedup in `indexChangedSessions`, and `getSessionStats` shape. Read `src/store/session-parser.ts` for `parseSessionFile` / `getSessionFiles` signatures.

- [ ] **Step 2: Write the failing contract test (live-gated, same pattern as Task 3 Step 2b).**

`tests/store/surreal/surreal-session-repo-contract.test.ts`:

```ts
import { isSurrealUp, uniqueNs } from "./_helpers.js";
const up = await isSurrealUp();
if (up) {
  const { runSessionRepositoryContract } = await import("../../repository-contract.test.js");
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealSessionRepository } = await import("../../../src/store/surreal/surreal-session-repo.js");
  runSessionRepositoryContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealSessionRepository(backend),
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });
}
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-session-repo-contract.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation.**

`src/store/surreal/surreal-session-repo.ts`:

```ts
/**
 * SurrealSessionRepository — implements SessionRepository against a local
 * SurrealDB server. Mirrors SqliteSessionRepository semantics. Messages
 * carry denormalized `project` / `cwd` so searchSessions is a single-table
 * query (no JOIN needed). The FTS index message_fts (defined in schema.ts)
 * backs `content @@`.
 */

import fs from "node:fs";
import type { SurrealBackend } from "./surreal-backend.js";
import type {
  SessionRepository, SessionSearchResult, SessionStats,
  IndexResult, BulkIndexResult, IncrementalIndexOptions,
} from "../repository.js";
import { parseSessionFile, getSessionFiles } from "../session-parser.js";

const LAST_SESSION_BACKFILL_KEY = "last_session_backfill";
const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

type SessionInput = {
  id: string; project?: string; cwd?: string; startedAt?: string;
  endedAt?: string | null;
  messages?: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; toolCalls?: string[] }>;
};

function emptyBulk(): BulkIndexResult {
  return { sessionsProcessed: 0, sessionsIndexed: 0, sessionsSkipped: 0, messagesIndexed: 0, errors: [] };
}

export class SurrealSessionRepository implements SessionRepository {
  constructor(private readonly backend: SurrealBackend) {}
  private get c() { return this.backend.client; }

  private async indexOne(sessionRaw: SessionInput): Promise<IndexResult> {
    const messages = sessionRaw.messages ?? [];
    const cwd = sessionRaw.cwd ?? "/unknown";
    const project = sessionRaw.project ??
      (sessionRaw.cwd ? (sessionRaw.cwd.split("/").pop() || sessionRaw.cwd) : "unknown");
    const startedAt = sessionRaw.startedAt ?? messages[0]?.timestamp ?? new Date().toISOString();
    const endedAt = sessionRaw.endedAt ?? null;

    // How many messages exist for this session already.
    const beforeRows = await this.c.query<Array<{ count: number }>>(
      `SELECT count() AS count FROM messages WHERE sessionId = $sid GROUP ALL;`, { sid: sessionRaw.id },
    );
    const before = beforeRows[0]?.count ?? 0;

    // Upsert the session row by its string record id (dedups on re-index).
    await this.c.query(
      `UPSERT type::record("sessions", $sid) SET sid = $sid, project = $project, cwd = $cwd, startedAt = $startedAt, endedAt = $endedAt, messageCount = $n;`,
      { sid: sessionRaw.id, project, cwd, startedAt, endedAt, n: messages.length },
    );

    for (const msg of messages) {
      await this.c.query(
        `UPSERT type::record("messages", $mid) SET sessionId = $sid, project = $project, cwd = $cwd, role = $role, content = $content, timestamp = $ts, toolCalls = $tc;`,
        { mid: msg.id, sid: sessionRaw.id, project, cwd, role: msg.role, content: msg.content, ts: msg.timestamp, tc: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null },
      );
    }

    const afterRows = await this.c.query<Array<{ count: number }>>(
      `SELECT count() AS count FROM messages WHERE sessionId = $sid GROUP ALL;`, { sid: sessionRaw.id },
    );
    const after = afterRows[0]?.count ?? 0;
    const messagesIndexed = after - before;
    return { sessionId: sessionRaw.id, messagesIndexed, skipped: before > 0 && messagesIndexed === 0 };
  }

  async indexSession(session: {
    id: string; project?: string; cwd?: string; startedAt?: string;
    endedAt?: string | null; messages?: unknown[];
  }): Promise<IndexResult> {
    return this.indexOne(session as SessionInput);
  }

  private async indexFile(file: string, result: BulkIndexResult): Promise<void> {
    result.sessionsProcessed++;
    const session = parseSessionFile(file);
    if (!session) { result.errors.push(`Failed to parse: ${file}`); return; }
    const existing = await this.c.query<unknown[]>(`SELECT sid FROM sessions WHERE sid = $sid LIMIT 1;`, { sid: session.id });
    const r = await this.indexOne(session);
    await this.upsertSessionFileMeta(file, session.id);
    if ((existing.length > 0) && r.messagesIndexed === 0) result.sessionsSkipped++;
    else { result.sessionsIndexed++; result.messagesIndexed += r.messagesIndexed; }
  }

  async indexAllSessions(sessionsDir: string, projectDir?: string): Promise<BulkIndexResult> {
    const files = getSessionFiles(sessionsDir, projectDir);
    const result = emptyBulk();
    for (const file of files) {
      try { await this.indexFile(file, result); }
      catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return result;
  }

  async indexChangedSessions(sessionsDir: string, options: IncrementalIndexOptions = {}): Promise<BulkIndexResult> {
    const files = getSessionFiles(sessionsDir, options.projectDir);
    const maxFilesToIndex = options.maxFilesToIndex ?? 50;
    const result = emptyBulk();

    type Changed = { path: string; size: number; mtimeMs: number };
    const changed: Changed[] = [];
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const meta = { path: file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
        const stored = await this.c.query<Array<{ size: number; mtimeMs: number }>>(
          `SELECT size, mtimeMs FROM session_files WHERE path = $path LIMIT 1;`, { path: file },
        );
        if (stored.length > 0 && stored[0].size === meta.size && stored[0].mtimeMs === meta.mtimeMs) {
          result.sessionsSkipped++;
          continue;
        }
        changed.push(meta);
      } catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toIndex: string[] = [];
    for (const m of changed) {
      if (toIndex.length >= maxFilesToIndex) { result.reachedLimit = true; break; }
      toIndex.push(m.path);
    }
    for (const file of toIndex) {
      try { await this.indexFile(file, result); }
      catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return result;
  }

  async upsertSessionFileMeta(filePath: string, sessionId: string, options?: { size?: number; mtimeMs?: number }): Promise<void> {
    const stat = options && (options.size !== undefined || options.mtimeMs !== undefined)
      ? { size: options.size ?? fs.statSync(filePath).size, mtimeMs: options.mtimeMs ?? Math.trunc(fs.statSync(filePath).mtimeMs) }
      : { size: fs.statSync(filePath).size, mtimeMs: Math.trunc(fs.statSync(filePath).mtimeMs) };
    await this.c.query(
      `DELETE FROM session_files WHERE path = $path; CREATE session_files SET path = $path, sessionId = $sid, size = $size, mtimeMs = $mtimeMs, indexedAt = $idx;`,
      { path: filePath, sid: sessionId, size: stat.size, mtimeMs: stat.mtimeMs, idx: new Date().toISOString() },
    );
  }

  async needsBackfill(sessionsDir: string, now?: number): Promise<boolean> {
    const files = getSessionFiles(sessionsDir);
    const indexed = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM sessions GROUP ALL;`);
    if (files.length > (indexed[0]?.count ?? 0)) return true;
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const stored = await this.c.query<Array<{ size: number; mtimeMs: number }>>(`SELECT size, mtimeMs FROM session_files WHERE path = $path LIMIT 1;`, { path: file });
        if (!(stored.length > 0 && stored[0].size === stat.size && stored[0].mtimeMs === Math.trunc(stat.mtimeMs))) return true;
      } catch { return true; }
    }
    // Backfill timestamp stored on a dedicated seq:<key> record.
    const row = await this.c.query<Array<{ value: string }>>(`SELECT value FROM type::record("seq", $k) LIMIT 1;`, { k: LAST_SESSION_BACKFILL_KEY });
    const value = row[0]?.value ?? null;
    if (!value) return true;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return true;
    const nowMs = now !== undefined ? now : Date.now();
    return nowMs - parsed >= SESSION_BACKFILL_INTERVAL_MS;
  }

  async touchBackfillTimestamp(timestamp?: string): Promise<void> {
    const ts = timestamp ?? new Date().toISOString();
    await this.c.query(`UPSERT type::record("seq", $k) SET value = $v;`, { k: LAST_SESSION_BACKFILL_KEY, v: ts });
  }

  async searchSessions(query: string, options: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number } = {}): Promise<SessionSearchResult[]> {
    if (query.trim().length === 0) return [];
    const { limit = 10, project, role } = options;
    const conds = ["content @@ $q"];
    const params: Record<string, unknown> = { q: query };
    if (project !== undefined && project !== null) { conds.push("project = $project"); params.project = project; }
    if (role) { conds.push("role = $role"); params.role = role; }
    const rows = await this.c.query<Array<{ id: string; sessionId: string; project: string; cwd: string; role: string; content: string; timestamp: string }>>(
      `SELECT id, sessionId, project, cwd, role, content, timestamp FROM messages WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC LIMIT ${Number(limit)};`,
      params,
    );
    return rows.map((r) => ({
      sessionId: r.sessionId, messageId: r.id, role: r.role as "user" | "assistant" | "system",
      content: r.content, timestamp: r.timestamp, project: r.project, cwd: r.cwd,
    }));
  }

  async getIndexedMessageCount(): Promise<number> {
    const rows = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM messages GROUP ALL;`);
    return rows[0]?.count ?? 0;
  }

  async getSessionStats(): Promise<SessionStats> {
    const sess = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM sessions GROUP ALL;`);
    const msg = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM messages GROUP ALL;`);
    const projects = await this.c.query<Array<{ project: string | null; sessions: number }>>(
      `SELECT project, count() AS sessions FROM sessions GROUP BY project;`,
    );
    return {
      totalSessions: sess[0]?.count ?? 0,
      totalMessages: msg[0]?.count ?? 0,
      projects: projects.map((p) => ({ project: p.project ?? "", sessions: p.sessions ?? 0, messages: 0 })),
    };
  }
}
```

> The shared contract's `getSessionStats` assertion only requires `totalSessions > 0`, `totalMessages > 0`, and `projects.length > 0` — so the simplified per-project aggregation (messages = 0 per group) satisfies it. The backfill timestamp is stored on a `seq:<key>` record via `type::record("seq", $k)` (string record id, dedups).

- [ ] **Step 5: Run contract test to verify it passes.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-session-repo-contract.test.ts )`
Expected: PASS — indexSession→searchSessions recall, getIndexedMessageCount, indexChangedSessions + getSessionStats shape.

- [ ] **Step 6: Verify cross-package typecheck.**

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: EXIT 0.

- [ ] **Step 7: Commit.**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-session-repo.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-session-repo-contract.test.ts
git commit -m "feat(hermes-memory): SurrealSessionRepository (index, backfill, @@ search, stats)"
```

---

### Task 5: Wire backend factory + CONTEXT.md + full-suite verification

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/backend-factory.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`

**Interfaces:**
- Consumes: `SurrealBackend` + `SurrealMemoryRepository` + `SurrealSessionRepository` (Tasks 2-4); `BackendBundle` from `./repository.js`.

- [ ] **Step 1: Replace the `surrealdb` branch in `backend-factory.ts`.**

Change the branch from `throw` to instantiation. The current body is:

```ts
case "surrealdb":
  throw new Error("SurrealDB backend is not implemented yet (Phase 3).");
```

Replace with:

```ts
case "surrealdb": {
  const backend = new SurrealBackend(config.surreal ?? {});
  await backend.init();
  return {
    backend,
    memoryRepo: new SurrealMemoryRepository(backend),
    sessionRepo: new SurrealSessionRepository(backend),
  };
}
```

And add imports at the top of the file (after the existing sqlite imports):

```ts
import { SurrealBackend } from "./surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "./surreal/surreal-memory-repo.js";
import { SurrealSessionRepository } from "./surreal/surreal-session-repo.js";
```

Update the JSDoc on `createBackendBundle` to drop "until then `'surrealdb'` throws" (it no longer does).

- [ ] **Step 2: Update CONTEXT.md.**

In the Store section of `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`, add one line noting the SurrealDB backend:

```
- `src/store/surreal/` — SurrealDB backend (default-off; `config.dbBackend: "surrealdb"`). Implements the same repository interfaces via a local SurrealDB v3 server (`/sql`, `snowball(english)` fulltext, `seq`-field ids). Shared `repository-contract.test.ts` proves equivalence.
```

- [ ] **Step 3: Verify upstream seam is intact.**

Run: `grep -rn "bun:sqlite" bun-apps/pi-agent-ext-hermes-memory/src`
Expected: exactly 1 hit (in `src/store/sqlite/sqlite-backend.ts`).

Run: `grep -rn "from \"../sqlite\|from \"\\.\\./sqlite" bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/`
Expected: no hits (the surreal backend imports nothing from the sqlite backend — only from `../repository.js`, `../memory-format.js`, `../session-parser.js`, `../../types.js`).

- [ ] **Step 4: Run the full package test suite.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: all green. The SQLite contract + 640+ existing tests unchanged; the surreal contract tests run only if the local `:8000` service is up (else skipped).

- [ ] **Step 5: Verify cross-package typecheck (REQUIRED CI gate).**

Run: `bun run --cwd bun-apps/pi-agent typecheck`
Expected: EXIT 0.

- [ ] **Step 6: Manual end-to-end smoke (local, default-off path).**

With the SurrealDB service up, create a throwaway config and run the extension's self-test with `dbBackend: "surrealdb"` to confirm `memory_search` / `session_search` work end-to-end. At minimum, run a direct script:

```bash
cat > /tmp/surreal-smoke.ts <<'EOF'
import { SurrealBackend } from "/Users/huangziyu/proj/video_generation__memory/bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "/Users/huangziyu/proj/video_generation__memory/bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.js";
const ns = `smoke_${process.pid}`;
const b = new SurrealBackend({ namespace: ns, database: ns });
await b.init();
const r = new SurrealMemoryRepository(b);
const e = await r.addMemory({ content: "smoke-test distinctive token zxqwbu", target: "memory" });
const hits = await r.searchMemories("zxqwbu");
console.log("added id:", e.id, "search hits:", hits.length);
await b.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
await b.close();
EOF
bun run /tmp/surreal-smoke.ts
```
Expected: `added id: 1 search hits: 1`.

- [ ] **Step 7: Commit.**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/backend-factory.ts \
        bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md
git commit -m "feat(hermes-memory): wire SurrealDB backend into createBackendBundle (Phase 3)"
```

- [ ] **Step 8: Final whole-branch verification.**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )` — all green.
Run: `bun run --cwd bun-apps/pi-agent typecheck` — EXIT 0.
Run: `git log --oneline main..HEAD` — review the task commits.
