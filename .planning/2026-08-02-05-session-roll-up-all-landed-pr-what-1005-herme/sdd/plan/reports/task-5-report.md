# Task 5 Report — Surreal `recordAssembly` + schemaless table

**Status:** ✅ Done

## Commits

- `75024f53` — `feat(hermes): Surreal recordAssembly + session_assembly schemaless table`

## Files changed (3, exactly the named set)

- `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/schema.ts` — appended `session_assembly` + `session_assembly_meta` SCHEMALESS tables and the three indexes (`session_assembly_md_id`, `session_assembly_session`, `session_assembly_meta_sid UNIQUE`).
- `bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-session-repo.ts` — implemented `recordAssembly(sessionId, mdIds, hash)` via `this.c`. Meta hash UPSERT (2-arg `type::record` keyed by sid) + `DELETE` prior assembly rows + deduped batched `CREATE` of the mdId set. The session doc UPSERT at `:83` is **untouched** (hash lives in `session_assembly_meta`).
- `bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-session-repo-contract.test.ts` — appended a `SurrealSessionRepository.recordAssembly` describe block, gated on the file's existing `if (up)` skip-if-no-Surreal guard.

## Verification

- **tsc (`bun run check`): exit 0** — closes the Task 4 expected error (`SurrealSessionRepository` now implements `recordAssembly`).
- **`bun test tests/store/surreal/surreal-session-repo-contract.test.ts`: 24 pass / 0 fail** — includes the new `recordAssembly > writes session_assembly rows + meta hash; idempotent; queryable by mdId` test. Asserts: dedup of `["m1","m2","m1"]` → `["m1","m2"]`, meta hash `h1`, and idempotent replace with `["m3"]`/`h2`.

## Deviation from brief (necessary, correctness-driven)

The brief specified the assembly-row insert as:

```surql
CREATE type::record("session_assembly") SET sessionId = $sid, mdId = $mN;
```

The single-argument `type::record("session_assembly")` form **errors at runtime on SurrealDB v3** — probed directly against the live server:

> `Could not cast into 'record' using input 'session_assembly'`

(The 2-arg `type::record(table, id)` form used for the meta UPSERT and the existing `messages` UPSERTs is correct and unchanged.) To create a random-id row in a SCHEMALESS table, the canonical form is a bare table name. The impl therefore uses:

```surql
CREATE session_assembly SET sessionId = $sid, mdId = $mN;
```

This was verified end-to-end against the live server (create rows, SELECT by `sessionId`, meta UPSERT + UNIQUE-index replace, DELETE-then-recreate idempotency) before writing the impl. All assertions in the brief's test are preserved unchanged; only the insert-statement form differs.

Other brief-fidelity notes:
- The session UPSERT at `:83` is NOT modified, per the brief.
- The test queries via the public `backend.client` (held reference) rather than the brief's `repo["c"]` bracket access. `repo["c"]` is a `private get` in `src`; although TS `private` is compile-time-only so runtime bracket access would work, `backend.client` is the same object via the public API and is cleaner. (Tests are excluded from `tsconfig.json`'s `include` anyway, so neither form is type-checked by `bun run check`.)

## Concerns

- None blocking. The single brief deviation (`CREATE session_assembly SET` vs the brief's broken `CREATE type::record("session_assembly")`) is the only material difference; it is required for the test to pass and is the idiomatic SurrealQL for a random-id insert into a SCHEMALESS table.
