# pi-hermes-memory — Knowledge-Layer Role

> TIER-0 foundation (ADR-hermes-memory-0001): raw memory I/O — store, search,
> session index, flush. Hermes owns orchestration (walk-and-ingest) and the
> capture journal; the vault-md knowledge graph — including ALL semantic/vector
> retrieval — is owned by `s2-agent-ext-knowledge-card` (zk). Hermes's own
> vector path was never armed and was deleted 2026-08-22 (ADR-hermes-memory-0002).

## The coupling shape (seam-only, no package dep)

Hermes has NO dependency on `@repo/s2-agent-ext-knowledge-card` (dep-guard:
hermes→zk via the `@repo/s2-agent-core-interface` seam ONLY —
`readSeam("__piKnowledgePipeline")`). Every vault write/read goes through
`kp.ingestRecords` / `kp.retrieveRecords` / `kp.healGraph` / `kp.buildHierarchy`.
When zk is absent the seam is unset and hermes degrades gracefully (archive
file + skip the knowledge path); it never imports zk modules directly. The former
optional-peer (`pi-knowledge-card` peerDep + `vault-converge.ts` dynamic
import) coupling described here before 2026-08-17 no longer exists in code.

## Role split (post #1556 / #1571 / 2026-08-17 polish)

| Concern | Owner |
| --- | --- |
| Capture journal store (surreal DEFAULT backend = store of record; sqlite = contracted fallback + test substrate) | hermes |
| Working-memory + session search, knowledge tools — pinned surface, ≤2100 schema tok (#1556) | hermes |
| Embedder/cosine/fence-split leaf (`embedding-leaf.ts`: defaultEmbedder, embedQuery, lmStudioAvailable, cosine, splitFencedYaml) | `@repo/s2-agent-core-interface` (hoisted 2026-08-17, L2) |
| Vault-md card graph, retrieval engine, hierarchy build/buildHierarchy | zk |

## Standing rules

- **Mirrors-must-hoist**: any new cross-package leaf duplication hoists to
  `@repo/s2-agent-core-interface` — never copy it (effort
  2026-08-17-knowledge-pipeline-polish, ticket L2).
- Hermes NEVER calls the convergence loop (retired with the CLI tier, L1) and
  NEVER imports zk.
