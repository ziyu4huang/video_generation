# 01 — SurrealDB client ownership

type: grilling
blocked by: (none)

## Question

kcard needs a SurrealDB client; the only one in the repo is `bun-apps/s2-agent-ext-hermes-memory/src/store/surreal/surreal-client.ts` (140 lines, dependency-free, v3 `/sql` HTTP, param binding via `LET`, retry/timeout). Where does the shared client live?

Options to grill:

1. **Extract into `@repo/s2-agent-core-interface`** (where `embedding-leaf.ts` already lives as the shared resolution point) — hermes and kcard both import from there.
2. **New tiny shared package** (`s2-agent-ext-surreal`-style lib face).
3. **kcard imports hermes's module directly** (couples two deliberately-decoupled packages — the context-lifecycle fold worked hard to keep them decoupled via the seam).
4. **Copy the client into kcard** (drift risk).

Constraints to respect: no package dependency between hermes and kcard in either direction today (cross-package calls go through `__piKnowledgePipeline` seam or core-interface); also settle whether ticket 01 touches the hermes backend-default ambiguity (leanrag-simplify D1 says SurrealDB default, `backend-factory.ts` defaults sqlite) — flag it, don't silently decide it.

## Resolution (2026-08-23, grilling 3 rounds — CLOSED)

Facts measured this session (this worktree, 2026-08-23):

- `surreal-client.ts` (140 lines) has exactly ONE hermes coupling: `import { bumpRoundTrips } from "../../perf.js"` (line 18). Sole consumer is `surreal-backend.ts` (both repos share one client instance). `per-user-db.ts` + `schema.ts` are hermes-side.
- hermes ALREADY runtime-depends on `@repo/s2-agent-core-interface` (`defaultEmbedder`, `GATE_DEFS`, `readSeam`); kcard peer-deps it. **Option 1 adds zero new dependency edges.**
- core-interface already hosts runtime infra (`embedding-leaf.ts`, `seam.ts`) — not a pure types package.
- `SurrealConnection` DEFAULTS live at `surreal-backend.ts:7`.
- Layering: extensions cannot import `@repo/s2-agent` (host); `publishSeam`/`readSeam` is the sanctioned host→extension config flow.

**D4 — extract the client into `@repo/s2-agent-core-interface`** (option 1). Move set (MVP, nothing more): `SurrealClient` with the `bumpRoundTrips` import converted to an injectable `onRoundTrip?: () => void` option (hermes passes it from `surreal-backend.ts`); the client's unit tests; a `SURREAL_DEFAULTS` const (`http://127.0.0.1:8000`, root/root) replacing `surreal-backend.ts:7` DEFAULTS. NOT moved: `per-user-db.ts` naming helpers (move when the kcard build needs them — ticket 02 era), `schema.ts`, repos, any env machinery. hermes side = import swap + hook injection, zero behavior change.

**D5 — SurrealDB is an embedded local service, not a standalone server** (user MVP stance): fixed endpoint constant, NO env-override leaf, no config-resolution layer. Only flexibility kept: the existing injectable `fetch` (tests) + constructor options.

**D6 — kcard index naming**: database `context_db` inside the per-user namespace `user_<sanitized-os-user>`. The user discriminator stays at the namespace layer (per-user-db.ts tenancy rationale); `context_db_<userid>` from the grilling lands as db `context_db` in the per-user ns — hermes `memory` and kcard `context_db` sit side by side under the same ns. hermes naming unchanged.

**D7 — hermes backend default FLIPS to SurrealDB** (user decision; resolves the leanrag-simplify D1 vs `backend-factory.ts` `config.dbBackend ?? "sqlite"` contradiction): default becomes `surrealdb`, sqlite stays as permanent backup/escape hatch. Accepted losses (user OK): corruption recovery (`withCorruptionRecovery`), `getDb` concrete-handle seams. NO auto-migration of existing sqlite data — the file stays as a manual-export backup. Back-written to the leanrag-simplify map.

**D8 — embedding config centralized in `bun-apps/s2-agent/src/pre-load-providers.ts`** (user directive): a new § exporting `EMBEDDING_CONFIG { base, model: "text-embedding-bge-m3" }`, base derived from the lm-studio provider entry (no second copy of the endpoint). Host publishes at startup via `publishSeam`; `embedding-leaf.ts` resolution order becomes **seam → env (`SEMANTIC_EMBED_*` / `LMSTUDIO_BASE_URL`) → built-in defaults**. Known trap carried: config does not reach `getCardEmbeddings` — A/B still needs per-call `semanticModel`.

The BUILD of D4–D8 lands in the post-`to-spec` build plan (this is a decision ticket); the client move itself is a zero-behavior-change commit.
