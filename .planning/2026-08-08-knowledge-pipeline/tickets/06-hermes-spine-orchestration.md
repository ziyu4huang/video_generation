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

## Resolution (2026-08-08, grilled)

Spine contract pinned across 4 forks. Hermes is the spine; zk is a primitives provider; the interface is a typed tenant of a new core-interface package.

- **Fork 1 — Spine owner:** Hermes owns the new agent-facing entry (`ingestPath` / `walkAndIngest`) + all store writes; it calls zk's primitives (`runConvergenceLoop` / `ingestRecords` / `retrieveRecords`). zk stays a pure, deterministic, no-LLM/no-DB primitive set.
- **Fork 3 — Exposure:** A typed `KnowledgePipeline` interface lives in a NEW `@repo/pi-agent-ext-core-interface` package (graduating the `__pi*` `globalThis` seam pattern into a first-class typed layer). zk publishes the impl via `globalThis.__piKnowledgePipeline`; hermes consumes defensively. Vault resolution + write stay in zk (hermes never depends on obsidian). → spawns ticket 11 (scaffold pkg + migrate existing `__pi*` seams); blocks 06's typed impl, not 06's closure.
- **Fork 2 — Walk policy (conservative):** `walkAndIngest` owns policy + per-type dispatch; unlimited depth but skip junk dirs (`.git`, `node_modules`, `_archive`, `.planning/sdd`); images OPT-IN (default off — VLM cost per ticket 07); symlinks skipped by default; binary denylist (archives/executables/media) + skip-if-extractor-empty.
- **Fork 4 — Amend 01:** 01's three core decisions (unified Card model; hermes store kind-agnostic via pluggable serializer; dedup single call-site) STAND. Only 01's orchestration/layering framing ("graph/ingest/RAG above, store below") is superseded by this ticket — correction note appended to 01.

Grounding code facts: zk already owns the full card-pipeline (`ingestRecords`, `runConvergenceLoop`, graph/RAG/merge, `collectInputFiles` walk); hermes owns the store (`MemoryRepository` / backend-ab, memory-shaped → generalize per 01) + FTS search, and has NO embeddings and NO file→card pipeline today; obsidian delegates embed to an external vault-mind/ChromaDB service.

closed: implemented-as-decision (contract pinned); impl blocked by ticket 11 (core-interface pkg).
