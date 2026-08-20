# pi-knowledge-card — Architecture

> Snapshot: 2026-07-14. **4 tools** (`zk_card`/`zk_ask`/`zk_ingest`/`knowledge_query`),
> 4 src modules. Test suite green. (Was documented as 6 tools; `zk_extract` +
> `graph_health` were removed in #450 — corrected 2026-07-14, see below.)

## What this package is

The **single source of truth** for Zettelkasten knowledge tooling in the pi
ecosystem. It owns two things:

1. **A pi extension** (`extensions/knowledge-card.ts`) that registers **4
   tools** — `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query`. (`zk_extract` was
   removed in #450 — it was a 100% passthrough to `obsidian_distill`, so callers use
   `obsidian_distill` directly; `graph_health` was merged into `obsidian garden`.)
   The task-builder strings + per-action tool allowlists every consumer (CLI, other
   extensions) imports.
2. **A deterministic library** (`src/*.ts`) — the convergence sink (ingest) and
   the graph READ side (retrieve), with no LLM and no network.

> **Vault resolution is delegated, not rolled-own.** Every tool resolves the
> convergence vault through pi-obsidian's `resolveVault(cwd)` (the multi-tier
> resolver: `OB_VAULT_PATH` env → run-dir config → Obsidian app → local). The
> hub asks its hard forward-dep (pi-obsidian) to *serve* vault resolution; the
> no-LLM tool (`knowledge_query`) uses the same resolver as the 3 subagent tools
> (`zk_card`/`zk_ask`/`zk_ingest`). (An earlier simplified resolver only checked env + cwd/"vault"
> and failed at runtime when the vault was config-registered — fixed in the
> consolidation cycle.)

The thesis: **structured knowledge from many sources converges into ONE shared,
queryable, backlinked graph** so `zk_ask` answers cross-source questions for
free. Tags + the wiki-link graph are the structure signal (semantic vectors were
measured and *retired* — see DEPENDENCIES / PR-HISTORY).

## The two ingestion modes

| Mode | Tool | Backed by | Input → Output | Determinism |
| ---- | ---- | --------- | -------------- | ----------- |
| **LLM distill** | `obsidian_distill` (pi-obsidian; was `zk_extract`, removed #450) | isolated subagent | free-form markdown/text → N atomic notes | LLM (lossy, creative) |
| **Deterministic ingest** | `zk_ingest` | `src/ingest.ts` (no LLM, no network) | structured `.knowledge.jsonl` records → 1 card each | byte-deterministic |

`zk_ingest` is the **convergence sink**. The self-improve loops already emit
STRUCTURED knowledge (`.knowledge.jsonl`); routing that through an LLM would be
lossy and non-deterministic and would re-introduce the per-workflow silos this
package exists to dissolve. `zk_ingest` maps each record 1:1 onto a canonical
card, dedup'd by id, cross-linked by shared tags, indexed by a MOC.

## Module map (src/)

```
src/ingest.ts   (934 LOC) — WRITE side. The convergence primitive.
  parseKnowledgeJsonl · adaptAutoMemoryMarkdown · extractFeatures (P1)
  ingestRecords · slugify · extractDate · normTag · cardTags · renderCard
  readCardMeta · writeMoc · formatSummary

src/retrieve.ts (600 LOC) — READ side. Symmetric to ingest.
  readActiveIds · retrieveRecords (shared-tag rank + P1 callout boost)
  graphHealth · healGraph · formatDigest · formatHealth

src/emit.ts     (100 LOC) — in-session event-bus contract (runtime surface).
  KNOWLEDGE_CHANNEL="pi:knowledge" · emitKnowledge · onKnowledge
```

`extensions/knowledge-card.ts` (1132 LOC) is the tool layer: the 4
`registerTool` blocks + the pure task builders (`buildDistillTask` (LIVE — backs CLI `zk-extract`, not vestigial) /
`buildAddTask` / `buildFindTask` / `buildUpdateTask` / `buildRemoveTask` /
`buildRagTask`) + the per-action allowlists (`DISTILL_TOOLS` / … / `RAG_TOOLS`)
+ the blend helpers (`rankBlendScore`, `ragToolsFor`). The CLI commands are thin
shells over these — **CLI and extension never drift** because they import the
same builders.

## Data flow

```
WRITE (converge)                          READ (answer)
─────────────────                         ──────────────
.knowledge.jsonl ─┐                       question
auto-memory/*.md ─┼─► zk_ingest ─► card ─► zk_ask ─► obsidian_search (seed)
hermes runtime ───┘    (ingest.ts)   .md     (buildRagTask)  └─► graph neighbors
                       │                               └─► cluster+rank ─► context ─► answer
                       └─► ## 連結 (shared-tag edges)    zk-query / knowledge_query
                       └─► Tags/Knowledge Graph.md (MOC)   └─► retrieveRecords (digest)
```

- **Edges come from shared tags**, not body wikilinks (body `[[..]]` are stripped
  to prose in `adaptAutoMemoryMarkdown`; the `## 連結` section is computed from
  tag overlap against the folder).
- **`retrieveRecords`** (zk-query / `knowledge_query` tool) ranks by shared-tag
  count with a bounded `+0.5` callout boost (P1, tie-break only).
- **`zk_ask`** (buildRagTask) uses `obsidian_search` + graph neighbor expansion,
  NOT `retrieveRecords` — two distinct read paths (see DEPENDENCIES).

### The two read paths — by-design ranking split (Stage 3, pinned)

`retrieveRecords` and `zk_ask` are **different retrieval mechanisms, not
aliases**, and they handle the P1 callout signal differently ON PURPOSE:

| | `retrieveRecords` (zk-query / `knowledge_query`) | `zk_ask` (`buildRagTask`) |
| --- | --- | --- |
| **Backed by** | the deterministic `src/retrieve.ts` library (no LLM) | an agent graph-RAG session |
| **Rank score** | shared-tag count (`+0.5` callout boost, tie-break only) | `0.7×search_score + 0.3×link_count` |
| **Frontmatter at rank time?** | ✅ yes (reads each card directly) | ❌ no (agent reads notes via `obsidian_read` only in Step 4, AFTER ranking) |
| **Callout handling** | **boost** (ranking) + **surface** (digest) | **surface only** (Step-4 instruction) |

**Why the split is correct, not accidental.** retrieveRecords is the
deterministic library — it reads each card's frontmatter directly, so
`hasCallouts` is available when it ranks; a bounded boost fits naturally. zk_ask's
score is computed by the agent from `obsidian_search` results, where frontmatter
is NOT available at Step 3 — so a callout boost there is impossible without an
extra read. zk_ask instead surfaces callouts via the Step-4 "Feature surfacing"
instruction (the note is read in Step 4, after ranking). Both paths surface the
callout text in the final context; only retrieveRecords also boosts ranking.

**Drift guard:** `retrieve.test.ts` pins this — retrieveRecords applies the
boost, AND `buildRagTask`'s Step-3 score line has NO callout term, AND Step-4
carries the surfacing instruction. A future edit that adds a callout term to
Step 3 (or removes the boost, or drops the Step-4 instruction) fails the test
and forces the by-design decision to be revisited + documented.

## Invariants (load-bearing — do not break)

1. **Atomic-zettel**: one canonical card per record, dedup'd by id. Chunking is
   rejected (kg-plan P5) — the graph IS the structure signal.
2. **Additive frontmatter**: `validateZettelNote` requires only `id`/`created`/
   `tags` (+ `tags[0]=="zettel"`). Every extra key (provenance, P1 feature flags)
   is additive — old cards validate + retrieve unchanged. Feature-less records
  stay byte-identical across ingest (the idempotency test guards this).
3. **Deterministic sink**: `zk_ingest` is byte-deterministic (same input → same
   card bytes). The MOC is regenerated from on-disk cards each run (never drifts).
4. **Graph-first**: lexical + graph won the retrieval measurement 4/5 (iter-7);
   semantic blends are opt-in `--blend` only, retired from the default READ path.

## Health primitives

`retrieveRecords`'s sibling exports keep the graph trustworthy:
- `graphHealth` — dead-link / MOC-drift / orphan audit, scoped to the
  convergence folder.
- `healGraph` — auto-heal: regenerate MOC + prune dead `[[..]]` links + dedup
  `相關：[[..]]` lines. **Scoped** — never touches human-authored cards outside
  the convergence folder. The smart pipeline (#345) gates publish on
  `graphHealth.ok`.

## Tests (no live LLM/subagent dependency)

- `pi-knowledge-card.test.ts` — pins pure task-builder output (all buildRagTask
  branches) + validation early-returns + tool registration.
- `allowlists.test.mjs` — **cross-package contract guard**: loads the real
  pi-obsidian extension, asserts every `obsidian_*` tool named in the allowlists
  is registered there. Catches pi-obsidian renames at test time.
- `toolWiring.test.mjs` — mocks `runSubagentWithRetry` + `resolveVault`, asserts
  each `execute()` wires the correct `(task, toolsCsv, tmpPrefix, opts)`.
- `e2e-orchestration.test.ts` — **full deterministic chain, real file I/O**:
  drives `zk_ingest` → `knowledge_query` (graph audit/heal now lives in `obsidian garden`) through the real
  `execute()` functions against a temp vault (`OB_VAULT_PATH` seam, no pi-obsidian
  mock). Proves cross-source edges form, callouts surface, retired cards are
  excluded, and re-ingest is byte-stable. The orchestration-proof test.
- `ingest.test.ts` / `retrieve.test.ts` / `merge.test.ts` / `blend.test.ts` /
  `emit.test.ts` — the deterministic library contracts (real temp vaults).

```bash
bun test        # from this package dir — 237 tests, <140ms
```

## See also

- [`DEPENDENCIES.md`](./DEPENDENCIES.md) — cross-package graph (who imports what).
- [`DATA-MODEL.md`](./DATA-MODEL.md) — card frontmatter schema + the 12-key record.
- [`PR-HISTORY.md`](./PR-HISTORY.md) — the knowledge-layer arc (#152 → #349).
- [`kg-improvement-plan.md`](./kg-improvement-plan.md) — the
  proposal backlog (P1 ✅, P3 ✅ closed; P2/P4/P6 deferred).
