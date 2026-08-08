---
type: grilling
claimed: pi/memory-session (grilling 06)
blocked by:
---
# 06 — Hermes-as-spine orchestration (revise 01)

## Question
01 placed graph/ingest/RAG HIGH in zk, store/CRUD/embed/query LOW in hermes. Grilling (2026-08-08) revised this to hermes-as-spine: hermes owns the pipeline ORCHESTRATION (ingest->card->graph->DB<->obsidian coordination + directory auto-walk + type-dispatch) AND the store/CRUD; zk is demoted to a primitives provider (graph-build / ingest / RAG) that hermes calls.

Pin the orchestration contract:
1. Orchestration API surface in hermes (method names + ownership): e.g. ingestPath(dir|file), upsertCard, query, dedup, buildGraph, syncToObsidian — which are hermes-owned vs zk-provided-and-called?
2. Directory-walk + type-dispatch policy (recurse depth, image-by-default vs opt-in, skip-binary, symlinks) — where enforced?
3. How zk's graph/ingest/RAG primitives are exposed to hermes (direct import / interface / plugin) and whether obsidian-vault-write is hermes- or zk-orchestrated.
4. What in 01's recorded decision text must be amended/marked-superseded.

Related: 01 (Card model, closed), 03 (graph, open).
