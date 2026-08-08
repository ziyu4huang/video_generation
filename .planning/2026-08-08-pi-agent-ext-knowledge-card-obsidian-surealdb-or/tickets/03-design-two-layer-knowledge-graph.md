type: grilling
blocked by: 01

## Question

The knowledge-graph has TWO layers (per grilling): a wiki-link layer and a typed entity-relation layer; the LLM entity-relation extraction is OPT-OUT (a speed/low-quality mode that skips it).

Pin the spec:
- **Wiki-link layer**: deterministic auto-linking rules — when does ingest insert a [[link]]? Shared topic-key? Shared entities? Shared source-file? Define the rule precisely so it is reproducible without an LLM. Builds on zk's existing wiki-link graph + MOC.
- **Entity-relation layer**: typed edges subject -> relation -> object. What relation schema (a fixed type set? free-form?)? Where do edges live — inline in card frontmatter, a separate DB table/index, or both? How are they queried?
- **Opt-out contract**: a single flag (e.g. kg.llm=false / env PI_KG_LLM=0) that disables LLM extraction and falls back to wiki-link-only. Define exactly what is skipped and what still runs.
- **Storage split across backends**: how the graph (links + relations) is represented in md (obsidian) vs indexed in SQLite (FTS + sqlite-vec) vs SurrealDB (native graph/embed).

Blocked by 01 (needs the card-agnostic card model to know what a card and its frontmatter are). Grilling, one fork at a time.
