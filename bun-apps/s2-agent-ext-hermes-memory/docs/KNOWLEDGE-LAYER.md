# pi-hermes-memory — Knowledge-Layer Role

> TIER-0 foundation (ADR-hermes-memory-0001): raw memory I/O — store, search,
> session index, flush. Hermes owns vectors (embedder wiring via LM Studio) and
> orchestration (walk-and-ingest); the vault-md knowledge graph is owned by
> `s2-agent-ext-knowledge-card` (zk).

## The coupling shape (seam-only, no package dep)

Hermes has NO dependency on `@repo/s2-agent-ext-knowledge-card` (dep-guard:
hermes→zk via the `@repo/s2-agent-core-interface` seam ONLY —
`readSeam("__piKnowledgePipeline")`). Every vault write/read goes through
`kp.ingestRecords` / `kp.retrieveRecords` / `kp.healGraph` / `kp.buildHierarchy`.
When zk is absent the seam is unset and hermes degrades gracefully (archive
file + skip semantic paths); it never imports zk modules directly. The former
optional-peer (`pi-knowledge-card` peerDep + `vault-converge.ts` dynamic
import) coupling described here before 2026-08-17 no longer exists in code.

## Role split (post #1556 / #1571 / 2026-08-17 polish)

| Concern | Owner |
| --- | --- |
| Memory store (surreal DEFAULT backend; sqlite = contracted fallback + test substrate) | hermes |
| Working-memory + session search, knowledge tools — pinned 6-tool surface, ≤2100 schema tok (#1556) | hermes |
| Embedder/cosine/fence-split leaf (`embedding-leaf.ts`: defaultEmbedder, embedQuery, lmStudioAvailable, cosine, splitFencedYaml) | `@repo/s2-agent-core-interface` (hoisted 2026-08-17, L2) |
| Vault-md card graph, retrieval engine, hierarchy build/buildHierarchy | zk |

## Standing rules

- **Mirrors-must-hoist**: any new cross-package leaf duplication hoists to
  `@repo/s2-agent-core-interface` — never copy it (effort
  2026-08-17-knowledge-pipeline-polish, ticket L2).
- Hermes NEVER calls the convergence loop (retired with the CLI tier, L1) and
  NEVER imports zk.
