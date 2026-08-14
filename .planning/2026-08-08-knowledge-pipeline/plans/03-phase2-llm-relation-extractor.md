# Plan — ticket 03 Phase-2: LLM relation extractor + entity summarization + relation dedup

- **Ticket:** `tickets/03-design-two-layer-knowledge-graph.md` (Phase-2 track; map decision-log "03-Phase2")
- **Spec:** `specs/2026-08-13-two-layer-knowledge-graph.md` (D1 LLM half, D4 gate, ⑥, ③)
- **ADR:** `docs/adr/0001-leanrag-selective-port.md`
- **Scope:** LlmRelationExtractor behind the shipped async `Extractor` seam + `kg.llm` gate (default OFF); a thin never-throws LM Studio chat client in zk; nested `relations:` frontmatter emission in ingest; ⑥ derived-only entity summaries; ③ `dedupByRelation` in hermes searchSemantic. Zero LLM cost when kg.llm is OFF (default path byte-identical to Phase-1).

## Context

Phase-1 shipped the substrate (PR #1296): async `Extractor` iface + `resolveExtractor(kgLlm)` gate (`extractor.ts:63-71` — kgLlm=true currently returns dictionary fallback with the "Phase-2: plug here" comment); kg.llm config wired end-to-end; `RetrievedCard.relations` across the seam; `normalizeRelation` + canonical serializer write-back in hermes. Seam research found 4 gaps this plan closes: (1) no LLM chat client exists in zk/hermes (only embeddings HTTP: `semantic.ts:44-56`; the distill path is agent-in-context, not HTTP; the repo's chat-completions client lives in movie-director which zk must NOT depend on); (2) `ExtractedEntity = {type,name}` has no description field and ⑥'s "condense via the embed endpoint" is imprecise — condensing needs a chat call; (3) zk `renderCard`/`renderFrontmatter` (ingest.ts:946-1053) emit scalars only — cannot write the nested `relations: [{s,rel,o}]` YAML block both readers parse; (4) `SemanticSearchHit` (semantic-search.ts:47-58) carries no relations — ③ needs them attached post-retrieval.

## Global Constraints

- **kg.llm OPT-IN, default OFF** — zero LLM cost + byte-identical default path when off (verified by existing suites staying green).
- **Never-throws at public boundaries** — LLM failure ⇒ dictionary fallback (house style: `embedQuery`→null, `lmStudioAvailable`→false). The chat client returns null on failure; the extractor degrades; ingest never crashes on LLM errors.
- **Thin chat client in zk, env-configured, injectable** — modeled on `semantic.ts`'s `Embedder` pattern (`LMSTUDIO_BASE_URL ?? http://localhost:1234`), borrowing movie-director's JSON-call contract (temperature 0.3, stream:false, retry-once at larger budget, tolerant parse) but WITHOUT a movie-director dependency. Model id: `PI_KG_LLM_MODEL` env / `IngestOptions.kgLlmModel`, default `"google/gemma-4-12b-qat"` (the repo's established chat model; configurable).
- **Write authority:** `relations:` frontmatter written ONLY by the LLM extractor's results (dictionary path emits entities only, never relations).
- **⑥ derived-only:** condensed summaries never touch canonical md; live in a derived side-cache mirroring `.knowledge-semantic/<model>.json` (mtime-fingerprint pattern, non-fatal cache-write failure).
- **③ canonical key:** `s → normalizeRelation(rel) → o` from hermes `relation-schema.ts` (T4); dedup is card-level on identical canonical relation signatures.
- **Test style:** hermes co-located `bun:test`; zk `__tests__/` + `bun run typecheck`.

## File Structure

**Create:**
- `bun-apps/pi-agent-ext-knowledge-card/src/llm-chat.ts` — thin chat client: `chatJson<T>(prompt, parseFn, opts)` → `T | null`; `LmChatOptions { apiUrl?, model?, timeoutMs?, _fetchImpl? }`.
- `bun-apps/pi-agent-ext-knowledge-card/src/entity-summary.ts` — ⑥: token estimator (~chars/4), merge-with-` | `, condense-via-chat, derived cache read/write.
- `bun-apps/pi-agent-ext-knowledge-card/__tests__/llm-chat.test.ts`, `__tests__/entity-summary.test.ts`.

**Modify:**
- `…/src/extractor.ts` — `LlmRelationExtractor implements Extractor` (few-shot prompt → entities+relations via chatJson; null/failure ⇒ delegate to DictionaryExtractor result). `resolveExtractor(kgLlm, opts?)` returns it when true.
- `…/src/entities.ts` — `ExtractedEntity` gains `description?: string` (additive; dictionary path leaves undefined).
- `…/src/ingest.ts` — when kgLlm ON: extractor runs regardless of the idf gate (dictionary entities stay idf-gated); relations consumed → emitted via a new nested-block emitter; `kgLlmModel` opt threading.
- `…/src/knowledge-pipeline-seam.ts` / core-interface `IngestOptions` — `kgLlmModel?: string` carrier.
- `bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts` — `SemanticSearchHit.relations?`; cheap warm-path graph attach (SQLite lookup by mdId, silent-skip when absent); private `dedupByRelation` sibling to `dedupByContentHash` applied on the return paths before the survivingK cap.

---

### Task 1 — Thin chat client (`llm-chat.ts`, zk)
**Goal:** `chatJson<T>(prompt, parseFn, opts): Promise<T | null>` — the repo's only chat-completions HTTP client in the bun-apps tree, in zk, dependency-free.
- Create `src/llm-chat.ts`: `LmChatOptions { apiUrl?: string; model?: string; timeoutMs?: number; _fetchImpl?: typeof fetch }` — every field injectable, all defaulted (env `LMSTUDIO_BASE_URL ?? "http://localhost:1234"` for apiUrl; `PI_KG_LLM_MODEL ?? "google/gemma-4-12b-qat"` for model), mirroring `semantic.ts`'s `Embedder` injection pattern.
- `chatJson` POSTs `${apiUrl}/v1/chat/completions` with `{ model, messages: [{ role: "user", content: prompt }], max_tokens, temperature: 0.3, stream: false }` (JSON-call contract borrowed from movie-director, no dependency on it).
- **Retry-once at a larger token budget:** first attempt `max_tokens` from opts; on failure (HTTP non-ok, timeout, or unparseable body) retry exactly once with a larger `max_tokens`; both attempts fail ⇒ return null.
- Timeout via `AbortSignal.timeout(timeoutMs)` (default mirroring semantic.ts's availability probe discipline, ~30s for chat).
- Tolerant parse: hand the assistant message content to the caller's `parseFn`; tolerate leading/trailing prose and fenced ```json blocks around the JSON body (strip fences before parse). ParseFn throws ⇒ null (never propagate).
- **Never-throws at the boundary:** ALL failures (HTTP error, timeout, unparseable) → `null`. No exceptions escape `chatJson`.
- `__tests__/llm-chat.test.ts` (new): **TDD** — injected `_fetchImpl` fixtures: success parse; retry-then-success (first call 500, second ok — asserts exactly 2 calls); unparseable body → null; HTTP 500 on both attempts → null; timeout/abort → null; fenced-JSON body parses.
- Produces: the chat client consumed by Tasks 2 & 4.
- Verify: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test __tests__/llm-chat.test.ts )`.

### Task 2 — LlmRelationExtractor (zk)
**Goal:** the LeanRAG ⑤ LLM half lands behind the shipped async `Extractor` seam; kg.llm=true stops being a graceful no-op.
- `src/extractor.ts`: `export class LlmRelationExtractor implements Extractor` — ctor takes `LmChatOptions`-shaped opts (threaded from `IngestOptions.kgLlmModel`/env). `extract(text)` builds a few-shot prompt (title+detail in; JSON `{entities:[{type,name,description?}], relations:[{s,rel,o}]}` out; few-shot examples in-prompt showing canonical core-6 rel names), calls Task-1 `chatJson`, validates/normalizes the parsed shape (drop malformed entries, coerce to `ExtractedEntity[]`/`Relation[]`).
- **Never-throws degradation:** any failure — chatJson null, empty/invalid payload — ⇒ return `DictionaryExtractor`'s result for the same text (entities only, relations `[]`). The extractor degrades; it never throws.
- `resolveExtractor(kgLlm, opts?)` returns `LlmRelationExtractor` when kgLlm true (replacing the Phase-1 fallback body; the "Phase-2: plug here" comment is updated to shipped reality).
- `IngestOptions.kgLlmModel?: string` — core-interface `src/interfaces/knowledge-pipeline.ts` + zk `src/knowledge-pipeline-seam.ts` publish (structurally, additive optional field; walk-and-ingest threads it alongside the existing `kgLlm` boolean).
- `__tests__/extractor.test.ts` (extend): **TDD** — injected chat fixture returning entity/relation triples → `extract` returns them verbatim; injected failure/null → result is dictionary-equivalent (compare against `DictionaryExtractor` on the same fixture text, relations `[]`); type-level `implements Extractor` satisfaction (the async iface from Phase-1 Task 3a — no signature ripple).
- Produces: the LLM extractor consumed by Tasks 3 & 4.
- Verify: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-core-interface && bun run check )` — default-path unchanged: existing tests green with kgLlm off.

### Task 3 — Relations write path in ingest (zk)
**Goal:** cards written by the LLM path carry the nested `relations:` YAML block, round-tripping through BOTH readers; the default (kgLlm off) path is untouched.
- `src/ingest.ts`: when the extractor returned non-empty `relations` (LLM path only — write authority), pass them into `renderCard` and emit via a **new dedicated nested-block emitter** (sibling to the entities emission at ingest.ts:997-999). `renderFrontmatter` (ingest.ts:1035) emits scalars only — the emitter writes the block separately (e.g. appended into the frontmatter region as a YAML sequence of `{s, rel, o}` mappings), NOT via the scalar map.
- **Round-trip contract:** the emitted block must parse via BOTH zk `parseRelationsBlock` (retrieve.ts:577-667) AND hermes `KnowledgeSerializer.parseRelations` (which canonicalizes `rel` through `normalizeRelation` on read). Zero tolerance for a block only one reader understands.
- **idf-gate carve-out:** with kgLlm ON, the extractor call moves OUTSIDE the `linkWeighting==="idf"` guard (dictionary entities stay idf-gated exactly as today; kgLlm off keeps the exact Phase-1 flow — byte-identical default path).
- `__tests__/ingest.test.ts` (extend): **TDD** — ingest with kgLlm on + injected extractor fixture returning relations → card md contains the nested `relations:` block AND `retrieveRecords` parses it back (`RetrievedCard.relations` populated); kgLlm off (and dictionary path generally) → no `relations:` block ever emitted (write authority assertion). **Cross-package round-trip:** a shared fixture string emitted by the zk emitter, parsed via hermes `KnowledgeSerializer.parseRelations` in a co-located hermes test — both readers proven against one artifact.
- Produces: persisted md relations consumed by Task 5's graph attach.
- Verify: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`.

### Task 4 — ⑥ entity summaries (zk)
**Goal:** LeanRAG ⑥ — merged same-entity descriptions condensed to a bounded budget via chat, derived-only, cached beside the semantic index.
- Create `src/entity-summary.ts`:
  - `estimateTokens(text) = Math.ceil(chars / 4)` — cheap heuristic estimator.
  - `mergeDescriptions(items): string` — `" | "`-join.
  - Condense: when merged text > ~512 tokens, call Task-1 `chatJson` with a condense prompt ("merge these duplicate descriptions into one, keep facts, ≤512 tokens"); chat null/timeout ⇒ return the merged raw text (never-throws, mirrors the client boundary).
  - Derived cache at `<vault>/.knowledge-semantic/entity-summaries-<llm-model>.json` — mtime/entities fingerprint keyed like `semantic.ts`'s `.knowledge-semantic/<model>.json`; non-fatal write failure (cache miss on read, log-free silent skip on write).
- `src/entities.ts`: `ExtractedEntity` gains `description?: string` (additive; dictionary path leaves it undefined — no behavior change there).
- Feed: condensed text augments the embed input — `cardEmbedText` overload or a sibling accepting an optional summary prefix (`semantic.ts:78`); canonical card md is NEVER rewritten (⑥ derived-only).
- `__tests__/entity-summary.test.ts` (new): **TDD** — estimator math (0-char → 0, exact ceil cases); merge join; under-threshold → no chat call (assert `_fetchImpl` never invoked); over-threshold → canned-chat condense (injected fixture returns short text, asserted as result); cache round-trip (write-then-read via temp dir); chat null ⇒ merged raw returned.
- Produces: ⑥ closed; embed-input augmentation consumed at the semantic-index call sites.
- Verify: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )`.

### Task 5 — ③ dedupByRelation (hermes)
**Goal:** LeanRAG ③ — relation-signature dedup in `searchSemantic`, with relations attached to hits post-retrieval.
- `src/store/semantic-search.ts`: `SemanticSearchHit.relations?: Array<{ s: string; rel: string; o: string }>` (optional — cold fallback paths don't carry it; do not assume present, mirroring `contentHash`).
- **Warm-path graph attach:** cheap SQLite lookup by `mdId` (read `graph` from the memories row, take `.relations`); silent-skip when the card/graph/row is absent — never blocks or fails search.
- Private `dedupByRelation(hits)` — sibling to `dedupByContentHash` (semantic-search.ts:115): canonical signature = sorted `s → normalizeRelation(rel) → o` triples joined (from `relation-schema.ts`, T4). Collapses hits whose signatures are identical AND non-empty — first hit kept, mirroring `dedupByContentHash` semantics. Empty/undefined relations NEVER collapse by this rule. Malformed relation entries never throw (skip entry).
- Applied **alongside** contentHash dedup on **all three return paths** (hnsw warm, zk-semantic, memory-lexical — the `slice(0, cap)` sites at ~206/264/295), **before** the survivingK cap.
- `src/store/semantic-search.test.ts` (extend, co-located): **TDD** — hits with identical canonical signatures (incl. alias variants like `ref` vs `references`) collapse to first; differing signatures don't; empty/undefined relations never collapsed; malformed entries don't throw.
- Produces: ③ closed; ticket 20's multi-signal entity-recall substrate complete.
- Verify: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`.

## Out of scope
- Persistent DB relation index (scale-trigger ticket >5k rels / >2k cards — still uncreated).
- Ticket 20 multi-signal frequency-vote + boostWeight (unblocked by THIS plan landing, separate ticket).
- LeanRAG ①② aggregation hierarchy (fog/future).
- CLIP/multimodal embeddings for entities (07's territory).
- Chat-model auto-probing/load management (movie-director's /api/v1/models machinery) — fixed configurable model id only.

## Execution handoff
SDD via subagent-driven-development into `.planning/2026-08-08-knowledge-pipeline/sdd/03-phase2-llm-relation-extractor/`; task order 1→5 (1 blocks 2&4; 2 blocks 3). NOTE process learnings from Phase-1: keep each task single-package where possible; dispatch targeted (not full-suite) verification per task; full-suite regression at whole-branch review. After all tasks green + whole-branch review, `gh ship` the branch into `main` (no `--auto`; remote CI is disabled by design).
