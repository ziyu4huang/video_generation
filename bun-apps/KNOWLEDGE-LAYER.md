# Memory / Knowledge Layer — Architecture Overview

> **AUTHORITATIVE top-level map** for the four extensions that form the agent's
> memory → knowledge layer. For depth, see each package's own docs (linked below).
> Snapshot: 2026-07-14 · branch `docs/memory-ext-architecture-review`;
> **lifecycle revision 2026-08-30** (effort `.planning/2026-08-22-context-lifecycle/`).
>
> ⚠ **CORRECTED 2026-07-18 (tier rule):** `s2-agent-ext-hermes-memory` is a
> **TIER-0 foundation** (raw memory I/O), NOT TIER-2. Its former auto-converge
> created illegal upward edges (hermes→knowledge-card, hermes→obsidian); those
> are removed — convergence ownership moves to the hub. The rule is enforced
> structurally by [`tests/dep-guard.test.ts`](./tests/dep-guard.test.ts).
>
> This overview is a *distillation* of the detailed review at
> `.planning/2026-07-14-memory-ext-architecture-review/findings.md` (every claim
> there is backed by a runnable `rg`/`git` citation).

## The lifecycle (2026-08-30 view)

The layer is best read as one loop, not two tiers of search:

```
CAPTURE      hermes journal + auto-capture + correction detection (session_shutdown flush)
   ↓
CONVERGE     zk_ingest = canonical sink (deterministic ingest; distill gate→enrich→converge
             actions; semantic-dedup pre-filter, opt-in; .distill-diff.json per-run audit)
   ↓
RETRIEVE     ONE retrieval path: kcard retrieveRecords (lexical+semantic blend, bge-m3
             canonical; tier-ladder render L0/L1/L2, demote-not-truncate). Obsidian search
             is lexical-only; hermes runs NO semantic search (capture-only, ADR-hermes-0002).
   ↓
INJECT       auto-recall injector (opt-in, DEFAULT OFF — measured D11): budgeted per-turn
             card block + RecallLedger cross-turn cooldown (retrieved ≠ served)
   ↓
FEEDBACK     used-ledger .knowledge-usage.jsonl (USED detection, 3 provenance sources)
             → hotness multiplier m(h)=1+0.1h (DEFAULT OFF until a populated ledger
             passes an unseeded on/off battery, D13)
```

Measurement surface: `s2-agent-ext-knowledge-card/scripts/retrieval-eval.mjs`
(`--corpus fixture|controlled|real` × model/blend/tier/hotness; baselines in the
context-lifecycle map ## Context) and the graded battery
`bun-apps/scripts/recall-audit.mjs`.

## The three tiers

```
TIER 0 — FOUNDATIONS (raw I/O; no upward edges allowed)
  s2-agent-ext-obsidian         vault I/O · parser · resolveVault · validateZettelNote
  s2-agent-ext-hermes-memory    memory I/O · store · search · session index · flush
        ▲                ▲
        │ hard import     │ hub reads hermes memory files at well-known path
        │ (down edge ✓)   │ on session_shutdown (NO hermes→hub edge — tier rule)
        └────────┬────────┘
                 ▼
TIER 1 — CONVERGENCE HUB: s2-agent-ext-knowledge-card
  zk_card · zk_ask · zk_ingest · knowledge_query
  src/ deterministic library: ingest.ts (WRITE) · retrieve.ts (READ) · merge · entities · emit
  zk_ingest = canonical convergence sink (4 source families: workflow-jsonl / hermes / auto-memory / generic)
  OWNS convergence: session_shutdown handler reads hermes + workflow sources → ingestRecords → obsidian write
                 │
                 ▼
        Zettelkasten/knowledge-graph/  ← single sink folder, shared-tag edges
```

## Per-extension responsibility

| Extension | Role | Tools |
| --- | --- | --- |
| [`s2-agent-ext-obsidian`](./s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md) | Foundation: vault I/O, frontmatter parser/validation, `resolveVault` | `obsidian` (1 fat tool, ~17 actions) |
| [`s2-agent-ext-knowledge-card`](./s2-agent-ext-knowledge-card/docs/ARCHITECTURE.md) | Convergence hub: deterministic ingest + retrieval over the shared graph | `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query` |
| [`s2-agent-ext-hermes-memory`](./s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md) | Working memory + session search; **capture-only since the 2026-08-22 fold** (ADR-hermes-memory-0002 — `knowledge_search` is lexical/tags-only; no vector path); hands convergence to the hub on `session_shutdown` | `memory`, `search_memory`, `knowledge_search` (lexical), `knowledge_ingest`, `skill_manage_help` |
| [`zk_ingest` distill actions](./s2-agent-ext-knowledge-card/) | Agent-self-triggered distillation of hermes entries (Gate→Enrich→Converge) | `zk_ingest` with `action=gate`/`converge`/`status` |

## Write path — sources → ONE shared graph

All convergence lands in the **same** folder `Zettelkasten/knowledge-graph/`, so
cross-source `[[edges]]` form by shared tags. `zk_ingest` is the canonical sink.

### ⚠ The two-writer conflict (C1) and the target-partition resolution

Two extensions write to that one folder. **As built today they are mutually
defeating:** hermes auto-converges entries raw on `session_shutdown` (runs first,
all targets); distill's gate then dedups against existing card bodies and **kills
the same entry as a duplicate** → distill's curated path is dead-on-arrival for
anything hermes touched.

**Resolved architecture (target partition + `superseded_by` precedence):**

| Knowledge class | Owner | Trigger | Card shape |
| --- | --- | --- | --- |
| `memory` + `user` (low-stakes working memory) | **hermes** auto-converge | `transfer` + `session_shutdown` | raw `type:pattern`, id `hermes:<slug>` (hub's `convergeHermesMemory` → `adaptHermesMarkdown`) |
| `failure` + `correction` + `insight` (high-value, curated) | **distill** | agent-triggered gate→enrich→converge | typed (`gotcha`/`lever`/…), id `distill:…` |

- distill's gate treats a matching **raw active card** (id prefix `hermes:` — the
  live hub adapter — or legacy `pi-memory:*` from the pre-tier-rule auto-converge)
  as an **upgrade candidate**, not a duplicate: on converge it writes the curated
  card and flips the raw card to `status: superseded` + `superseded_by: <curated id>`.
  *(F3, corrected: the gate previously recognized only `pi-memory:*`, so cards
  minted by the current `hermes:<slug>` adapter were killed as duplicates and the
  curated upgrade path never fired for them.)*
- retrieve already excludes `superseded`/`retired` cards, so the raw card silently
  drops out of answers. (Caveat: `ingestRecords` defaults `status: active`, so
  superseding is an explicit 2-step op, not automatic.)
- distill is now runtime-wired as `zk_ingest` actions (`gate`/`converge`/`status`) inside knowledge-card; the gate→enrich→converge flow is the surface above.

## Read path — which tool when (R4 decision tree)

| Intent | Tool |
| --- | --- |
| Working memory entries, user prefs, categorized lessons | `search_memory` (hermes) |
| Past conversation / session context | `search_memory` session lane (hermes) |
| Structured knowledge digest by tags (deterministic, no LLM) | `knowledge_query` |
| Natural-language cross-source Q&A (graph-RAG, LLM) | `zk_ask` |
| Vault note full-text / Dataview-style query | `obsidian search` / `obsidian query` |

## "Which distill?" (R3 disambiguation)

| Name | What it is |
| --- | --- |
| `obsidian distill` (action) | Raw LLM decomposition of free-form markdown → atomic notes |
| `zk_ingest` (tool) | Deterministic structured-records → graph sink (no LLM) |
| `zk_ingest` `action=gate`/`converge`/`status` | distill pipeline (was the `distill` extension): gate → enrich → converge |
| `buildDistillTask` (knowledge-card export) | **Live** builder — backs the CLI `zk-extract` subcommand (`s2-agent/src/cli/commands/zk-extract.ts:30,139`). The `zk_extract` *tool* registration was removed in #450; the *builder* remains. Not vestigial. |

## Known issues tracked in the review

- **C1** 🔴 distill vs hermes two-writer mutual defeat → R1 (above).
- **C2** ✅ resolved — knowledge-card docs corrected (2026-07-14 note in
  `ARCHITECTURE.md`): `zk_extract` removed in #450 (use `obsidian_distill`;
  `buildDistillTask` remains as the live CLI builder), `graph_health` merged into
  `obsidian garden`.
- **C3** 🟡 "distill" naming collision (3 concepts share the name) → R3 (above).
  *(Correction 2026-07-14: `buildDistillTask` is LIVE CLI code, not vestigial —
  the original review conflated the removed `zk_extract` tool with the live builder.)*
- **C4** 🟡 five overlapping search surfaces → R4 (above).
- **C5** ✅ resolved — distill is now runtime-wired as `zk_ingest` actions (`gate`/`converge`/`status`) inside knowledge-card; the standalone `distill` extension was folded in.
- runSubagentWithRetry lives in `s2-agent-ext-subagent` (moved pre-2026-08-17; the old tier-0 placement was a docs ghost, cleared 2026-08-17).

## Package deep-dives

- [s2-agent-ext-obsidian — KNOWLEDGE-LAYER](./s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md)
- [s2-agent-ext-knowledge-card — ARCHITECTURE](./s2-agent-ext-knowledge-card/docs/ARCHITECTURE.md)
- [s2-agent-ext-hermes-memory — KNOWLEDGE-LAYER](./s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md)

## 2026-08-17 polish (effort knowledge-pipeline-polish)

- **L1 CLI retirement**: zk `loop.ts` + `merge.ts` + `kcard-loop` CLI + merge
  stages/flags retired; seam members `mergeDuplicates` / `runConvergenceLoop`
  removed from the pipeline contract.
- **L2 leaf hoist**: embedder/cosine/fence-split leaf now lives in
  `@repo/s2-agent-core-interface` `src/embedding-leaf.ts`; hermes'
  `store/surreal/embedder.ts` + `store/frontmatter-codec.ts` mirrors deleted;
  zk `semantic.ts` delegates. Standing rule: mirrors must hoist, never copy.
- **L3**: dead `INTERVIEW_PROMPT` export removed.
- Hierarchy (#1571): `buildHierarchy` seam + aggregation MOCs + retrieval
  `viaTree` auto-expansion — no-tree retrieval byte-identical.
