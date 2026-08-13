---
status: active
effort: 2026-08-08-knowledge-pipeline
ticket: "03"
date: 2026-08-13
grill: 2026-08-13
---
# Two-layer knowledge graph — design home (knowledge-pipeline ticket 03)

> **This is the design home for ticket 03.** It supersedes the prior design home
> — the ticket-03 *resolution block* ("two-layer graph contract pinned") plus the
> `CardGraph` type-only placeholder in
> `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`. Those pinned the
> *contract* (the layering + the `Card.graph?` shape + the `kg.llm` opt-in flag);
> **this spec pins the *build*** — the extraction front-end, the storage wiring,
> the schema-normalization rule, and the entity-summarization gate that turn the
> contract into something buildable.

## 1. Status & provenance

**SYNTHESIZE output of the 2026-08-13 grill on ticket 03.** The grill converted
ticket 03's parked build sub-decisions (closed 2026-08-08 as a
DESIGN-decision with its build forks deferred) into a buildable spec. Scope of
the grill: DECIDE → SYNTHESIZE only — it did **not** re-litigate the four settled
forks (storage, schema, LLM, storage-split).

This spec supersedes:
- the **ticket-03 resolution block** (`tickets/03-design-two-layer-knowledge-graph.md`
  — the contract pinning, which stands as *context* but not as a build spec);
- the **`CardGraph` type-only placeholder** in
  `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts` (the type home exists
  but no persistence path does — see §5).

**Source artifacts:**
- **Ticket 03** — `tickets/03-design-two-layer-knowledge-graph.md` (resolution
  block: two-layer contract pinned, build forks parked).
- **Ticket 01** — `tickets/01-define-hermes-zk-layering-contract.md` (the
  layering contract + invariants 03 must respect; the unified `Card` model +
  the kind-agnostic store via a pluggable serializer + dedup as a single
  store call-site).
- **Brainstorm** — `brainstorm/leanrag-knowledge-pipeline-adoption.md`
  (LeanRAG concept breakdown; ⑤ extraction + ⑥ entity-summarization land here).
- **This grill** — 2026-08-13; resolved D1–D4 + folded defaults.

## 2. Context

Ticket 03 is the **structural unblocker** for the effort: it is what produces
*typed entities* in the store, which ticket 20 (LeanRAG multi-signal
frequency-vote) depends on. It is also the **design home** for two LeanRAG base
concepts — ⑤ (pluggable extraction front-end) and ⑥ (entity-description
summarization).

### The 01 invariants this spec must respect

These are load-bearing; nothing in §3–§4 may violate them:

- **Graph rides `Card.graph?`** — the typed entity-relation layer is a field on
  the kind-agnostic `Card`, never a separate top-level store. `CardGraph`
  (`bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`) is its type home.
- **Join key is `Card.id` ↔ `memories.md_id`.** Entities/relations join back to a
  card by the same stable canonical id every other store feature uses (NOT the
  numeric DB rowid).
- **Vault-md writes are zk-owned; the hermes store is read-only for knowledge
  cards.** `KnowledgeSerializer.deserialize` reads vault obsidian-md into a
  `Card`; the store does not write knowledge-cards back through the serializer
  (zk owns `renderCard` + `## 連結` + MOC). The *exception* carved by D2 is
  narrow: the `relations:` frontmatter field, written only by the `kg.llm`
  extractor (see §4 D2).
- **Graph/ingest/RAG logic stays HIGH in zk; persistence/DB-mirror stays DOWN in
  hermes** (the hermes-as-spine revision of 01 / ticket 06). The extractor
  interface + the two impls are zk-side primitives; the persistence of
  `Card.graph` into SQLite is the hermes-side mirror.

## 3. The two layers

(settled baseline, 2026-08-08 — formalized, not re-litigated)

### Layer 1 — wiki-link layer (deterministic, zero-LLM)
**Formalize as-is.** The existing deterministic shared-tag rule IS the spec:
`scoreOverlap` over shared-tag sets (`count` default, `idf` opt-in mode),
top-`maxLinks` (20) neighbors → `## 連結` `- 相關：[[<slug>]]` + MOC at
`Tags/Knowledge Graph.md` + obsidian VaultIndex (backlinks / dead-links /
orphans). **No expansion** to shared-entities or shared-source-file — clean
layer separation (entities live in Layer 2; source-file is a weak/noisy signal).
This layer already exists in zk and is untouched by this build.

### Layer 2 — typed entity-relation layer (subject → relation → object)
**Does not exist yet; this is the build.** Typed edges (`{s, rel, o}`) live on
`Card.graph.relations`. The four settled forks frame it:
- **Storage:** md frontmatter = source-of-truth + derived index (in-memory
  rebuild at small scale; persistent DB index at scale).
- **Schema:** HYBRID — core enum
  `{references, depends-on, extends, contradicts, supersedes, implements}` +
  free-form fallthrough.
- **LLM:** opt-in via `kg.llm` (config) / `PI_KG_LLM` (env); **DEFAULT OFF**.
- **Storage split (fork 4):** collapsed — answered by the storage fork above.

## 4. Decisions (the core of this spec)

Each of D1–D4 records the decision, the rationale, and what it
unblocks / gates.

### D1 — LeanRAG ⑤ extraction front-end
**Decision.** A shared `Extractor` interface emitting a canonical entity/relation
shape, with **two impls**:
1. **Dictionary-anchored extractor (DEFAULT, ON).** EXTENDS zk's existing
   deterministic 8-type taxonomy
   (`bun-apps/pi-agent-ext-knowledge-card/src/entities.ts`, which explicitly
   *rejects LLM-at-ingest*). Emits **entities only, never relations**.
2. **LLM few-shot extractor (OPT-IN, behind `kg.llm=true`).** Emits entities
   *and* typed relations (writing `relations:` frontmatter). This is Phase-2 of
   the same build.

**Rationale.** Honors the pinned default-OFF toggle + the "reject LLM at ingest"
cost-class stance that `entities.ts` already encodes; LeanRAG ⑤ "pluggable
extraction" is satisfied by one interface + two impls; the LLM path becomes
Phase-2 of *this* build rather than a separate effort.

**Unblocks / gates.** Unblocks LeanRAG ⑤ (extraction) with a concrete home.
Unblocks ticket 20 (which needs typed entities — emitted by both impls). The
dictionary path alone makes the entity half of the graph usable with **zero LLM
cost**; relations wait for the opt-in path.

### D2 — Storage wiring (the build gap)
**Decision.**
- **Phase-1 (this build):** persist `Card.graph` by serializing it into the
  existing SQLite `memories.frontmatter` JSON column — so `Card.graph`
  **round-trips** and the in-memory rebuild is **real** (today it round-trips as
  `undefined`; see §5).
- **Defer** the persistent DB relation index (SurrealDB `RELATE` edge-table OR a
  SQLite `relations` table) to a **separate scale-trigger ticket**. Pin the
  crossover trigger at: **>5,000 relations OR >2,000 knowledge cards**.
- **Write authority:** the `relations:` frontmatter field is written **ONLY by
  the `kg.llm` extractor**. The default dictionary path emits entities only,
  never relations, and writes no `relations:` field.

**Rationale.** Closes the concrete build gap (§5 bullet 1) without committing to
a persistent edge index before scale justifies it; keeps the in-memory rebuild
path honest (it rebuilds from real persisted state, not from `undefined`); and
nails the write-authority boundary so the default path can never accidentally
produce relations.

**Unblocks / gates.** Unblocks the acceptance criterion that `Card.graph`
persists + round-trips. Gates the persistent relation index behind a measured
scale trigger (deferred ticket). Gates LeanRAG ③ full relation-dedup behind
real persisted relations (D3 prepares the dedup key meanwhile).

### D3 — Schema normalization
**Decision.** An **open enum with free-form fallthrough** — nothing is rejected
at ingest. A **one-way alias display-map** normalizes the core 6 predicates for
**QUERY-TYPING and LeanRAG ③ dedup-canonicalization ONLY**:
lowercase + alias, e.g. `ref` → `references`; free-form predicates
(e.g. `is-a`, `uses`) **stay free-form**. Relations are **STORED AS-EMITTED**,
never coerced at write. Dedup (`set()`) operates on the **canonicalized key**.

**Rationale.** High recall (no rejections at ingest) + the core 6 stay
queryable + LeanRAG ③ relation-dedup becomes viable once relations exist
(canonical key = the dedup input).

**Unblocks / gates.** Makes the core predicates queryable without constraining
extraction recall. Prepares the dedup key for LeanRAG ③ (which is still GATED
behind real persisted relations from D2 Phase-2 / the `kg.llm` path).

### D4 — LeanRAG ⑥ entity-summarization
**Decision.** Gated behind `kg.llm`. Runs **ONLY in the LLM extractor path**
(the dictionary path is a no-op — it produces no verbose text to summarize).
Merge same-entity descriptions with ` | `; **when a merged description exceeds
~512 tokens, condense** via the **EXISTING LM Studio embed endpoint** (one model,
one round-trip). Condensed text is **DERIVED-ONLY** — it never overwrites the
canonical card md. (Exact token threshold deferred to impl.)

**Rationale.** Puts summarization where there is actually verbose text to
condense (the LLM path), reuses the already-provisioned embed endpoint rather
than introducing a new model/call, and keeps the canonical card md immutable
(consistent with "hermes store read-only for knowledge cards").

**Unblocks / gates.** Gives LeanRAG ⑥ a concrete, gated home. No cost on the
default path (dictionary extractor = no-op for ⑥).

### Folded default — wiki-link weighting (Layer 1)
**Decision.** KEEP `count` as the default `scoreOverlap` mode (preserve the
iter-7 baseline); `idf` stays opt-in. **No change.** Captured here only so the
grill record is complete; it is not a Layer-2 decision.

## 5. Build-gap findings (load-bearing)

These four findings MUST be read before any build of Layer 2 begins — the build
must not be planned on false assumptions. They are **decided-in-direction,
unwired-in-code** as of 2026-08-13:

1. **`Card.graph` round-trips as `undefined` through SQLite today** (not
   persisted, not indexed). The type home exists (`CardGraph` in
   `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`), but there is no
   persistence path — confirmed at `card.ts` ("NOT persisted/indexed in 06a …
   round-trip as `undefined`"). **D2 Phase-1 closes this.**
2. **Surreal knowledge persistence is a literal no-op placeholder** — the store
   throws/"03/04/06b placeholder" for knowledge on the Surreal backend
   (`card-store.ts`: "SurrealDB knowledge persistence is a 03/04/06b
   placeholder no-op"). **D2 defers the persistent index; Phase-1 rides SQLite.**
3. **`kg.llm` / `PI_KG_LLM`: zero code matches.** The flag is named (in a comment
   in `card.ts`) but **not implemented** — there is no config read, no env read,
   no toggle wired anywhere in code. **D1/D2/D4 all depend on this flag actually
   being wired (default OFF).**
4. **No entity store, no relation store, no typed-edge table exists anywhere.**
   The only graph today is SurrealDB `tagged` RELATE over *memory* implicit tags
   (`schema.ts` `DEFINE TABLE tagged`; `surreal-memory-repo.ts` `RELATE …->tagged`),
   which is **memory-target-specific and NOT an entity-relation graph.**
   `KnowledgeSerializer` *parses* `relations:` frontmatter into
   `Card.graph.relations`, but nothing persists or indexes it.

## 6. Deferred / out-of-scope

- **Persistent DB relation index** — a separate **scale-trigger ticket**;
  crossover at **>5,000 relations OR >2,000 knowledge cards**. Phase-1
  (`Card.graph` into `memories.frontmatter`) is in scope; the SurrealDB `RELATE`
  edge-table / SQLite `relations` table is not.
- **md↔DB sync drift** — owned by **ticket 05's 3-tier drift policy**
  (Tier 1 md-canonical / Tier 2 derived-cache / Tier 3 DB-authoritative).
- **LeanRAG ③ full relation-dedup** — **GATED** behind 03 actually building
  typed relations; D3's normalization rule *prepares the dedup key* but the dedup
  itself is not built here.
- **LeanRAG ①②** — UMAP/GMM aggregation hierarchy + LCA retrieval = **fog/future**
  (per ADR-0001 + the brainstorm); revisit when retrieval *coverage*, not
  redundancy, is the bottleneck.

## 7. Build-facing acceptance criteria (testable)

- [ ] `Card.graph` **persists + round-trips** through SQLite (no longer
      `undefined`) — `entities` + `relations` survive an ingest→retrieve cycle.
- [ ] An **`Extractor` interface exists** with (a) the dictionary impl
      **default-ON** (emits entities only, extends `entities.ts`) and (b) an LLM
      impl **behind `kg.llm`** (emits entities + relations).
- [ ] The **`kg.llm` / `PI_KG_LLM` flag is actually wired** (config read + env
      override) and **defaults OFF** — currently zero code matches.
- [ ] The **alias-map normalization** is applied at **query-typing + dedup only**
      (canonicalized key); relations are **stored as-emitted**, never coerced at
      write; nothing is rejected at ingest.
- [ ] LeanRAG **⑥ runs only when `kg.llm=true`** (dictionary path = no-op for ⑥);
      condense via the existing LM Studio embed endpoint; condensed text is
      derived-only (never overwrites canonical card md).
- [ ] **Layer-1 wiki-link behavior is unchanged** (`count` default; `idf`
      opt-in; `maxLinks` 20; `## 連結` + MOC).
- [ ] **Zero LLM cost on the default ingest path** (flag OFF → dictionary
      extractor only → entities only, no relations, no ⑥).

## 8. Unblocks

- **Ticket 20** (LeanRAG multi-signal frequency-vote) — needs typed entities,
  which both extractor impls now emit.
- **LeanRAG ⑤ (extraction)** and **⑥ (entity summarization)** now have a
  concrete home (the `Extractor` interface + its two impls; ⑥ gated behind
  `kg.llm`).
- LeanRAG ③ relation-dedup remains gated behind real persisted relations, but
  D3's normalization rule prepares its dedup key.
