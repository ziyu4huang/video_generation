**ID:** `ADR-s2-agent-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# The knowledge stack keeps two retrieval paths, deliberately not unified

zk-query (and the `knowledge_query` tool) and zk-ask are two DIFFERENT retrieval
mechanisms, not two front-ends over one engine. `retrieveRecords` is a
deterministic, in-process function: shared-tag ranking plus a boost, returning a
digest, with no LLM and zero token cost. `buildRagTask` drives the agent through
graph-enhanced RAG: a search seed, N-hop wiki-link expansion, a rank
(0.7×lexical + 0.3×link), a tiered full-read, and LLM synthesis with references.
They are kept separate because they optimize for different things — a
reproducible, free digest vs. a synthesized, cited answer — and unifying them
would force one to pay for the other: folding the LLM into `retrieveRecords`
would make the digest nondeterministic and token-burning; stripping the graph
expansion out of `zk-ask` would lose the structure signal that bridges concepts
across languages better than semantic vectors alone. This mirrors the distill
pipeline's determinism boundary (ADR-0003): across both the WRITE and READ
sides, the knowledge stack uses deterministic functions for what must be
reproducible and a single agent-LLM step for what must be flexible.
