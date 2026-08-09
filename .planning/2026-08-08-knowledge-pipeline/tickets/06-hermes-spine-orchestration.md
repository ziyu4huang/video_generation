---
type: grilling
status: implemented
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

## Implementation split (2026-08-09) — ✅ both tracks SHIPPED

Ticket 06's implementation was split into two grilling/build tracks; **both are now shipped** (contract closed 2026-08-08, typed impl complete 2026-08-09):

- **06a — card-agnostic store** ✅ **SHIPPED — PR #1141** (squash `61e6019a`; spec+plan was PR #1137). Generalized hermes `MemoryStore`/`MemoryRepository` → a kind-agnostic store over `Card { id, kind, content, frontmatter, embed?, graph? }` + pluggable `CardSerializer` (memory + knowledge) + pluggable `DedupStrategy` (memory + knowledge). Memory-cards coexist byte-identical (regression-green); knowledge-cards round-trip from vault-md. zk unchanged (read-only).
  - Spec: `.planning/2026-08-08-knowledge-pipeline/specs/2026-08-08-hermes-card-store.md`
  - Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-08-hermes-card-store.md`
- **06b — spine orchestrator** ✅ **SHIPPED — PR #1146** (squash `3bd0d694`; spec+plan was PR #1143). `walkAndIngest` (policy walk + source-family detection + ingest + heal + DB-mirror into the unified store) + `healGraph` published as a 5th `KnowledgePipeline` seam leaf + `knowledge_search`/`knowledge_ingest` tools + Tier-1 drift stub. Embed (04) / full drift (05) / migration (13) stay out.

06a stood alone (no zk changes, no orchestrator); 06b depended on 06a's store being built + proven on knowledge-cards first.

## 06b spec + plan + impl (2026-08-09) — ✅ SHIPPED

06b (spine orchestrator) spec + TDD plan were drafted (PR #1143), then **implemented in PR #1146** (squash `3bd0d694`). The 4 grilled decisions below are now realized in code:

- Spec: `.planning/2026-08-08-knowledge-pipeline/specs/2026-08-08-hermes-spine-orchestrator.md`
- Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-08-hermes-spine-orchestrator.md`

**4 grilled decisions pinned** (verbatim in the spec §"The 4 grilled decisions"):

1. **Orchestration = leaf primitives only.** hermes owns `walkAndIngest`; calls zk leaves via `getKnowledgePipeline()`; NEVER calls `runConvergenceLoop`. Heal = a NEW leaf `healGraph(opts): Promise<HealReceipt>` added to `KnowledgePipeline` (core-interface), published by zk, called by hermes after ingest. (Verified grounding: `healGraph` ALREADY exists as a standalone leaf in zk `retrieve.ts` — `loop.ts` composes it as Phase B — so 06b only PUBLISHES it, it does not extract new heal logic.)
2. **Walk policy = hermes owns it.** `walkAndIngest` implements the policy walk + source-family detection; does NOT use `collectInputFiles` for the policy walk.
3. **Retrieve UX = new `knowledge_search` tool** wrapping `retrieveRecords`, mirroring `memory-tool.ts`.
4. **Store writes = DB-mirror only.** zk writes vault-md; hermes reads vault-md → `KnowledgeSerializer` → `card-store.upsertCard` (single dedup site = 06a `KnowledgeDedupStrategy`, id-upsert).

**Scope IN:** `walkAndIngest` (walk + family-detect + ingest + heal + DB-mirror + Tier-1 drift stub), the `healGraph` seam addition, the `knowledge_search` tool, vault-path plumbing (env-only). **OUT (other tickets):** embed (04), full drift (05), graph indexing (03), memory-card migration (13), image ingest (07), `.planning` self-ingest (08/09). A flagged Option B (6th `ingestFiles` seam leaf for full generic-md ingest) is documented but NOT the default path (Option A = workflow-jsonl via hermes-side JSONL parse → `ingestRecords`).
