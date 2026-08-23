# 05 — FS-style read surface

type: prototype
blocked by: 02 (needs the index to answer ls/tree cheaply)

## Question

OpenViking's identity is the `viking://` virtual FS — agents browse context with `ls/tree/find/grep/stat` instead of querying a black box. Design kcard's equivalent read surface as a **prototype to react to** (cheap, rough, concrete):

- Shape: new tools (`kcard_ls`, `kcard_tree`, `kcard_find`, `kcard_grep`) vs one tool with an `op` param vs folding into `knowledge_query`?
- Each op must return tier-ladder output (L0 summaries by default, L1 on demand) — the existing `renderTier` is the renderer.
- What addresses the ops? Vault-relative card paths already exist; do we need a `kcard://`-style URI or are vault paths the URIs?
- Tool-surface impact: does `zk_ask` get absorbed? Consult the tool-gating contract and hermes's `__piKnowledgePipeline` seam consumers before deciding.
- Deterministic-only, zero LLM tokens per op (consistent with D5/D6).
