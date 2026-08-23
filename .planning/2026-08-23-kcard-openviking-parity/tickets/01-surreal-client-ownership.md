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
