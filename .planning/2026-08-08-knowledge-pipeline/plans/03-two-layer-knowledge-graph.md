# Plan — ticket 03: two-layer knowledge graph (deterministic substrate + pluggable extraction)

- **Ticket:** `tickets/03-design-two-layer-knowledge-graph.md`
- **Spec:** `specs/2026-08-13-two-layer-knowledge-graph.md`
- **ADR:** `docs/adr/0001-leanrag-selective-port.md` (⑤ pluggable extraction; ⑥ entity summarization; ③ relation-dedup — the latter two deferred to Phase-2)
- **Scope:** Phase-1 (default deterministic path) — make `Card.graph` persist, introduce the `Extractor` interface with the dictionary impl default-on, wire the `kg.llm` config seam (default OFF, no LLM impl yet), add hybrid-schema relation normalization + serializer write-back, and plumb typed edges across the core-interface seam. **Zero LLM cost on the default path.**

## Context

Today the two-layer graph is "designed but unwired": the `CardGraph` type exists (`bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`) but `graph` round-trips as `undefined` through SQLite (dropped in `rowToCard`/`upsertCard`); the deterministic 8-type extractor `extractEntities` (`bun-apps/pi-agent-ext-knowledge-card/src/entities.ts`) runs but is a free function, not behind an interface; `kg.llm`/`PI_KG_LLM` have zero code matches (flag named in a doc-comment only); `KnowledgeSerializer` parses `relations:` frontmatter on read but never re-emits it on write; and `RetrievedCard` (`bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts`) carries no `relations` field. This plan builds the deterministic substrate that makes all of that real, with **no LLM at ingest** (deterministic-by-design, per ADR-0001). The LLM opt-in path (D1's second impl, ⑥, ③) is Phase-2 and plugs into the interface this plan establishes.

## Global Constraints

- **LLM typed-relation extraction is OPT-IN, default OFF** (`kg.llm` config / `PI_KG_LLM` env). Zero LLM cost when off — deterministic-by-design (ADR-0001).
- **md is source-of-truth for relations; the DB index is DERIVED.** This plan persists `Card.graph` so it round-trips; the persistent DB relation index (SurrealDB `RELATE` / SQLite relations-table) is deferred to a scale-trigger ticket (>5,000 relations OR >2,000 knowledge cards).
- **Config = 4 points:** `constants.ts` default → `types.ts` `MemoryConfig` field → `config.ts DEFAULT_CONFIG` → `config.ts loadConfig()` allowlist guard. (Pattern proven by ticket 14 `vectorTopK`/`vectorEf` and ticket 19 `survivingK`.)
- **Schema is HYBRID:** core enum `{references, depends-on, extends, contradicts, supersedes, implements}` + free-form fallthrough; alias-map normalizes the core 6 for query-typing + dedup only; relations stored as-emitted, never coerced at write.
- **Layer separation:** wiki-link layer (Layer 1) is formalize-as-is — **no change** in this plan. Relations/entities stay in Layer 2. Wiki-link default weighting stays `count` (iter-7 baseline), `idf` opt-in.
- **Write authority:** `relations:` frontmatter is written only by an LLM extractor (not present in this plan); the default dictionary path emits **entities only**, never relations.
- **01 invariants:** graph rides `Card.graph?` (kind-agnostic); join key is `Card.id` ↔ `memories.md_id`; vault-md writes stay zk-owned; graph/ingest/RAG logic stays HIGH in zk, persistence/DB-mirror stays DOWN in hermes.
- **Test style:** hermes = `bun:test` co-located `src/**/*.test.ts` (+ `tests/`); zk = `bun test __tests__/` (no co-located tests). hermes `bun run check` = `tsc --noEmit`; zk has no `check` — run `bun run typecheck`.

## File Structure

**Create:**
- `bun-apps/pi-agent-ext-knowledge-card/src/extractor.ts` — `Extractor` interface + `DictionaryExtractor` (wraps existing `extractEntities`).
- `bun-apps/pi-agent-ext-hermes-memory/src/store/relation-schema.ts` — `CORE_RELATIONS` set + `normalizeRelation(rel)` alias-map normalizer.

**Modify:**
- `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` — add `graph TEXT` to `CREATE TABLE memories`.
- `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` — `ensureMemoriesColumns()` ALTER for `graph TEXT` + fresh-DB CREATE column-set.
- `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` — `CARD_SELECT_COLUMNS`, `CardRow.graph`, `rowToCard`, `upsertCard`, `updateCard` for graph round-trip.
- `bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.ts` — `parseRelations` (canonicalize via `normalizeRelation`), `serialize()` emit `relations:`.
- `bun-apps/pi-agent-ext-hermes-memory/src/{constants,types,config}.ts` — `kgLlm` 4-point config.
- `bun-apps/pi-agent-ext-knowledge-card/src/ingest.ts` — route entity extraction through `DictionaryExtractor`; read `PI_KG_LLM`/`IngestOptions.kgLlm`.
- `bun-apps/pi-agent-ext-knowledge-card/src/retrieve.ts` — `retrieveRecords` returns `relations` (from `graph.relations`).
- `bun-apps/pi-agent-ext-knowledge-card/src/knowledge-pipeline-seam.ts` — publish `relations`/`kgLlm` structurally.
- `bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts` — `RetrievedCard.relations?`, `IngestOptions.kgLlm?`.

---

### Task 1 — Graph persistence (close the build-gap)
**Goal:** `Card.graph` survives a SQLite round-trip (currently drops to `undefined`).
- `src/store/sqlite/schema.ts:96`: add `graph TEXT` to the `memories` CREATE TABLE (nullable, mirrors `frontmatter TEXT`).
- `src/store/sqlite/sqlite-backend.ts:772-776` (`ensureMemoriesColumns`): add idempotent `ALTER TABLE memories ADD COLUMN graph TEXT`; also add `graph TEXT` to the fresh-DB CREATE column-sets at ~1030 & ~1162.
- `src/store/card-store.ts`: add `graph` to `CARD_SELECT_COLUMNS`; add `graph: string | null` to `CardRow`; decode `graph` in `rowToCard` (`graph ? JSON.parse : undefined`); encode `graph` (`JSON.stringify(card.graph ?? null)`) in `upsertCard` INSERT + `updateCard` SET.
- `src/store/card.test.ts` (extend): **TDD red→green** — write a card with `graph: { links: ["x"], entities: [{type:"tool",name:"mflux"}], relations: [{s:"a",rel:"references",o:"b"}] }`, read it back, assert `graph` equals the input (round-trip). Pre-fix this fails (`graph === undefined`); post-fix passes. Also assert a card with no `graph` round-trips as `undefined` (nullable).
- Produces: persisted `Card.graph` consumed by Tasks 4 & 5.
- Verify: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`.

### Task 2 — Extractor interface + DictionaryExtractor (LeanRAG ⑤)
**Goal:** deterministic extraction sits behind a pluggable `Extractor` interface; default impl wraps the existing 8-type extractor.
- Create `src/extractor.ts` (knowledge-card): `export interface Extractor { extract(text: string): { entities: ExtractedEntity[]; relations: Relation[] } }` (relations always `[]` for the dictionary impl) + `export class DictionaryExtractor implements Extractor` whose `extract` delegates to the existing `extractEntities` and returns `{ entities, relations: [] }`. Re-export `ExtractedEntity`/`EntityType` from `entities.ts`.
- `src/entities.ts`: keep `extractEntities`/`inferType`/`scoreOverlap`/`computeIdf` unchanged (they remain the dictionary core); add a one-line `export type Relation = { s: string; rel: string; o: string }`.
- `src/ingest.ts` (~1536-1544): replace the direct `extractEntities(…)` call with `new DictionaryExtractor().extract(…)` (or a module-level registry singleton); assign `.entities` to the graph-build path. Behavior unchanged.
- `__tests__/extractor.test.ts` (new): **TDD** — assert `DictionaryExtractor.extract(text)` returns `{ entities: <same as extractEntities(text)>, relations: [] }` (equivalence vs the existing function over a fixture); assert the interface is satisfied (`implements Extractor`). Pre-existing `extractEntities` test in `__tests__/` must still pass.
- Produces: `Extractor` interface + `DictionaryExtractor` consumed by Task 3 (gate) and by Phase-2's `LlmRelationExtractor`.
- Verify: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )`.

### Task 3 — `kg.llm` / `PI_KG_LLM` config seam (D4, default OFF)
**Goal:** the opt-in flag is real and wired (4-point config + zk env/opts), default OFF; only `DictionaryExtractor` is registered, so turning it on is a no-op until Phase-2 adds the LLM impl.
- hermes `src/constants.ts`: `export const DEFAULT_KG_LLM = false;` (mirror `DEFAULT_SURVIVING_K`).
- hermes `src/types.ts` (`MemoryConfig` ~206): add `kgLlm: boolean;`.
- hermes `src/config.ts` (`DEFAULT_CONFIG`): `kgLlm: DEFAULT_KG_LLM`; in `loadConfig()` allowlist: accept `kgLlm` (boolean), default to `DEFAULT_KG_LLM`, reject unknown keys (mirror `survivingK`).
- knowledge-card `src/ingest.ts`: read `PI_KG_LLM` env (`process.env.PI_KG_LLM === "1"`) and/or `IngestOptions.kgLlm`; thread into the extractor-selection point from Task 2. When `kgLlm` is true, fall back to `DictionaryExtractor` (graceful no-op — do NOT throw; Phase-2 plugs the real impl here).
- core-interface `IngestOptions`: add `kgLlm?: boolean;`.
- hermes `src/config.test.ts` (extend, or `tests/config.test.ts`): **TDD** — assert default `kgLlm === false`; assert env/allowlist override flips it true; assert unknown key rejected.
- Produces: the opt-in flag consumed by Phase-2's LLM extractor + ⑥.
- Verify: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )` and `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )`.

### Task 4 — Hybrid schema + alias-map normalization (D3) + serializer write-back
**Goal:** relations are canonicalized on read and re-emitted on write (write-back is currently incomplete); the normalizer prepares the LeanRAG ③ dedup key for Phase-2.
- Create `src/store/relation-schema.ts` (hermes): `export const CORE_RELATIONS = new Set(["references","depends-on","extends","contradicts","supersedes","implements"]);` + `export const RELATION_ALIASES: Record<string,string> = { ref: "references", refs: "references", reference: "references", dependson: "depends-on", "depends_on": "depends-on", extend: "extends", contradict: "contradicts", supersede: "supersedes", implement: "implements" };` + `export function normalizeRelation(rel: string): string { const k = rel.trim().toLowerCase(); return RELATION_ALIASES[k] ?? k; }` (free-form fallthrough unchanged).
- `src/store/knowledge-serializer.ts` `parseRelations`: apply `normalizeRelation` to each `rel` when building `graph.relations` (canonicalize on read).
- `src/store/knowledge-serializer.ts` `serialize()`: emit `relations:` back to YAML frontmatter (round-trip write-back) when `graph.relations` is non-empty.
- `src/store/knowledge-serializer.test.ts` (extend): **TDD** — round-trip a card whose `relations:` contains `{s:"a", rel:"ref", o:"b"}` → after deserialize `rel === "references"` (canonicalized); a free-form `rel:"uses"` stays `"uses"`; serialize re-emits the canonical `relations:` block; a card with no relations round-trips without a `relations:` block.
- Produces: `normalizeRelation` consumed by Phase-2's `dedupByRelation` (③) + the serializer write-back consumed by Task 5.
- Verify: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`.

### Task 5 — Typed-edge return across the core-interface seam (D2)
**Goal:** typed relations cross the hermes↔zk seam so `retrieveRecords` can serve them (empty by default — dictionary path emits no relations).
- core-interface `src/interfaces/knowledge-pipeline.ts`: add `relations?: Array<{ s: string; rel: string; o: string }>` to `RetrievedCard`.
- knowledge-card `src/retrieve.ts` `retrieveRecords`: populate `relations` from each card's `graph.relations` (parsed via `KnowledgeSerializer` → already canonicalized by Task 4).
- knowledge-card `src/knowledge-pipeline-seam.ts` `publishKnowledgePipeline`: assign `relations` structurally (zk's richer type narrows to the contract subset at the seam).
- `__tests__/retrieve.test.ts` (extend, or co-located): **TDD** — ingest a card with `relations:` frontmatter, retrieve via `retrieveRecords`, assert `RetrievedCard.relations` is populated + canonicalized; ingest a plain card, assert `relations` is `undefined`/empty. Add/extend the seam-contract test so the new field typechecks.
- Produces: typed edges available downstream — the substrate ticket 20 (Phase-2) and LeanRAG ③ build on.
- Verify: `( cd bun-apps/pi-agent-ext-core-interface && bun run check )` + `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck && bun test )` + `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`.

## Out of scope (Phase-2 / separate)
- **`LlmRelationExtractor` impl** (LeanRAG ⑤ LLM half) — plugs into the `Extractor` interface from Task 2 behind the `kg.llm` gate from Task 3. Separate plan/ticket.
- **LeanRAG ⑥ entity-summarization** — gated behind `kg.llm`; merge ` | `, condense via the LM Studio embed endpoint when >~512 tok; derived text only. Separate.
- **LeanRAG ③ relation-dedup (`dedupByRelation`)** — sibling to `dedupByContentHash` in `semantic-search.ts`; needs relations to flow (Task 5) + the canonical key (Task 4). Separate.
- **Persistent DB relation index** (SurrealDB `RELATE` / SQLite relations-table) — scale-trigger ticket (>5k relations / >2k cards).
- **LeanRAG ①②** (UMAP+GMM aggregation hierarchy + LCA retrieval) — fog/future.
- **Ticket 20** (multi-signal frequency-vote + `boostWeight`) — blocked by 03; this plan delivers the deterministic entity substrate, partial unblock.
- **md↔DB drift policy** — ticket 05.

## Execution handoff
SDD-ready: each task names Files / Consumes / Produces + a red→green TDD scenario + a verification command. Execute via `superpowers:subagent-driven-development` (one implementer subagent per task) into the SDD workspace the superpowers `sdd-workspace` script resolves to `.planning/2026-08-08-knowledge-pipeline/sdd/03-two-layer-knowledge-graph/` (effort-aware, committed audit trail; only `progress.md` is transient). After all tasks green + whole-branch review, `gh ship` the branch into `main` (no `--auto`; remote CI is disabled by design).
