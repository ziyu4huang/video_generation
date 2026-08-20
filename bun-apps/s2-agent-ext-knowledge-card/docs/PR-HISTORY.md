# pi-knowledge-card — PR History (the knowledge-layer arc)

> Snapshot: 2026-07-07. The cumulative story of how this package became the
> convergence sink + graph-RAG read side. Reverse-chronological; each entry:
> what landed, the thesis it advanced, and the artifact/receipt that proves it.

## The arc at a glance

```
#152 contract guard  →  f395761e unified convergence  →  7c556b17 closed-loop
   (test scaffolding)       (zk_ingest birth)              (retrieve + graphHealth)
   → ebd6afd7 dir-ingest   →  #345 smart pipeline  →  #341 semantic CLOSURE
      (auto-memory + heal)    (merge.ts + auto-trigger)     (retire semantic blend)
   → #349 feature-aware (P1)
      (callout/task/embed metadata → ranking + context)
```

## #349 — feature-aware retrieval (P1) · 2026-07-07 · MERGED (squash f95eeea)

**Thesis:** vault-mind's `EnhancedMarkdownParser` extracts 9 structured-feature
categories that `zk_ingest` dropped entirely (spike:
`output/spike-vaultmind-vs-zkingest-parsing.json`). Carry the ones with a
retrieval lever (callouts → ranking + context; tasks/embeds → filter flags).

**Landed:**
- `extractFeatures()` in `src/ingest.ts` — detects callouts (`> [!type]`),
  tasks (`- [ ]`/`- [x]`), embeds (`![[…]]`), fenced-code density (code-fence-aware).
- **Additive** frontmatter keys written only when present: `has_callouts`,
  `callout_types`, `has_tasks`, `open_task_count`, `embed_count`,
  `code_block_lines`. Feature-less records stay byte-identical.
- `readCardMeta` returns `hasCallouts` + `calloutTypes`.
- `retrieveRecords`: bounded `+0.5` callout boost (tie-break only — after
  shared-tag count, before id localeCompare; never beats a strictly-more-tag card).
- `formatDigest`: lifts the callout headline into the digest line.
- `buildRagTask` Step 4 (zk_ask path): "surface callouts first" instruction.
- `RetrievedCard` gained `hasCallouts` + `calloutText`.

**Measurement:** the real human-authored surface has **0 callouts** (grep
2026-07-07), so the LLM-judge `relevance@4` harness would be a vacuous
zero-delta. The mechanism was proven deterministically
(`scripts/p1-feature-measure.mjs`): rankLift + noDisplacement + surfacingDelta
all pass → SHIP. Receipts: `output/p1-feature-measurements/`.
**kg-improvement-plan P1 → CLOSED.**

## #345 — smart knowledge pipeline · 2026-07-07 · MERGED (squash 076e4c19)

**Thesis:** the convergence sink was trustworthy but NEVER auto-triggered —
knowledge piled up in `.knowledge.jsonl` until a human ran `zk-ingest`. Make the
loop self-cleaning: auto-trigger → single-hop converge → merge/purge.

**Landed:**
- `src/merge.ts` (368 LOC) — `findDuplicatePairs` (title/body/tag similarity ≥
  threshold) + `mergeDuplicates` (safe in-place merge: union tags, concat
  detail, pick best title, supersede the loser) + `formatMerge`.
- `retrieve.ts`: `graphHealth` exposed for the publish gate (publish refuses if
  the graph is drifted).
- The smart-pipeline glue (in `.claude/workflows/` + the power-tool ext):
  extract → publish (zk_ingest) → converge → graphHealth gate → merge/purge.

**Result:** 429 active cards, 0 retired surfaced, 0 dead links, 0 merge
candidates post-run. The graph is now self-maintaining.

## #341 — semantic-retrieval fork CLOSURE · 2026-07-07 · MERGED (squash b07acc6b)

**Thesis:** the semantic-blend question (`three-way` / `semantic-lexical` vs
lexical+graph) had recurred across 5 iterations. Measure it definitively and
either retire or invest.

**Landed (in this package):** the `zk_ask` blend description got a *permanent
decision* — `default` (lexical+graph) is the vault-wide default **PERMANENTLY**;
semantic blends are `--blend` opt-in only.

**Measurement (iter-7, 5/5 ranked, all semantic-live):** `default` mean
relevance@4 **0.770** vs `semantic-lexical` **0.466**; lexical wins **4/5**.
Cross-regime with iter-6 (zh-TW 0.332 vs 0.100). Receipt:
`output/iter7-receipt-2026-07-07T01-00-52.json`.
**kg-improvement-plan P3 → CLOSED (RETIRE).**

> Do NOT re-open the semantic question without a NEW corpus/regime (~10× vault
> or a different vault-mind embedding model). The graph layer is the structure
> signal.

## ebd6afd7 — directory ingest for auto-memory + heal dedup

**Thesis:** the second convergence source (auto-memory `*.md`) needed
first-class support, and re-ingest could emit duplicate `相關：[[..]]` lines.

**Landed:**
- `collectInputFiles` — recursive directory expansion per source family
  (`.knowledge.jsonl` for workflow-jsonl, `.md` for auto-memory/hermes), skipping
  index rollups (`MEMORY.md`/`README.md`).
- `adaptAutoMemoryMarkdown` — maps a memory topic file (name/description/
  metadata.type frontmatter) onto a `KnowledgeRecord`; harvests `[[links]]` +
  `#hashtags` as cross-link tags; strips body wikilinks to prose (no dead links).
- Neighbour-pool **dedup** in `ingestRecords` — a card present both on disk and
  in the batch (upsert) is counted once; re-ingest is byte-idempotent.
- `healGraph` dedup step — collapses duplicate `相關：[[..]]` lines in-card.

## 7c556b17 — closed-loop knowledge graph (retrieve.ts birth)

**Thesis:** ingest existed but there was no READ side — the graph was write-only.

**Landed:** `src/retrieve.ts` — `readActiveIds` (caller's own ids to exclude),
`retrieveRecords` (ANY-tag match, shared-tag rank, self-exclusion, digest),
`graphHealth` (dead-link/MOC-drift/orphan audit), `healGraph` (auto-heal),
`formatHealth`. The `zk-query` CLI + the `knowledge_query` tool became its
shells. This made the graph **queryable cross-workflow**.

## f395761e — unified extension knowledge-graph convergence (zk_ingest birth)

**Thesis:** every self-improve workflow produced its own `.knowledge.jsonl`
silo; there was no shared graph. Dissolve the silos.

**Landed:** `src/ingest.ts` — the deterministic convergence primitive. The
12-key `.knowledge.jsonl` schema → one canonical card (dedup'd by id,
cross-linked by shared tags, indexed by a Knowledge Graph MOC). The `zk_ingest`
tool. The atomic-zettel + deterministic-convergence model — the package's
founding thesis (chunking was rejected here, kg-plan P5).

## #152 — cross-package contract guard + happy-path wiring

**Thesis:** the tools spawn subagents that call `obsidian_*` tools by name; a
rename in pi-obsidian would silently break them at runtime.

**Landed:** `__tests__/allowlists.test.mjs` (loads the real pi-obsidian
extension, asserts every allowlisted tool is registered) +
`__tests__/toolWiring.test.mjs` (mocks the subagent runner, asserts each
`execute()` wires the correct task/tools/prefix). The test scaffolding that
made every later refactor safe.

## #173 — promptSnippet across tools

**Landed:** `promptSnippet` added to the tool registrations (close the
`extension_analyzer` loop — every tool needs a snippet for the system prompt).

## consolidation cycle — hub + scribe + dependency-hygiene · 2026-07-07

**Thesis:** after P1 (#349) + P3 (#341) closed the measurement questions, the
layer was feature-settled but had two real gaps: (1) no in-package architecture
docs, and (2) a misplaced reverse-dep — `s2-agent-ext-power-tool` registered
`knowledge_query` + `graph_health` (knowledge-graph tools) forcing it to depend
on pi-knowledge-card. The hub should own its tools.

**Landed:**
- **`docs/`** — `ARCHITECTURE.md`, `DEPENDENCIES.md` (canonical cross-package
  graph), `DATA-MODEL.md`, `PR-HISTORY.md` (this file) + symmetric
  `docs/KNOWLEDGE-LAYER.md` in pi-obsidian / s2-agent-cli / pi-hermes-memory.
- **Hub consolidation** — `knowledge_query` + `graph_health` migrated from
  power-tool into this extension; power-tool's `pi-knowledge-card` dependency
  **deleted**. Reverse-dep graph: **3 → 2 consumers** (s2-agent-cli +
  pi-hermes-memory). power-tool is self-contained diagnostics again.
- **Vault-resolution delegation (runtime fix, same cycle)** — the migrated
  tools initially carried a simplified resolver (env + cwd/"vault" only) that
  FAILED at runtime when the vault was config-registered (the common case:
  `obsidian_config.json` vault_path). Fixed by delegating to pi-obsidian's
  multi-tier `resolveVault(cwd)` — the SAME resolver the native zk_* tools use.
  This is the hub "asking pi-obsidian to serve it" for vault resolution, not
  rolling its own. Error path made deterministic via a test seam
  (`__setVaultResolverForTest`) because resolveVault's Tier-2 (Obsidian app)
  fallback resolves the real open vault on any dev machine.
- **Ranking-split drift guard** — pinned the by-design decision that
  `retrieveRecords` applies the P1 callout boost (it reads frontmatter at rank
  time) while `zk_ask`'s `buildRagTask` surfaces-but-doesn't-boost (the agent
  lacks frontmatter at Step 3). A test catches a future edit that desyncs them.
- **kg-plan steady-state** — P2/P4/P6 marked DEFER/COLLAPSED/DROP with explicit
  reopen-conditions (P6 measured: 2/429 cards = 0.4% hierarchical tags).

---

## Cumulative state (2026-07-07, post-consolidation)

| Dimension | State |
| --------- | ----- |
| Convergence sink | ✅ deterministic, idempotent, 2 sources (workflow-jsonl + auto-memory) |
| Read side | ✅ retrieveRecords (rank+digest) + zk_ask (graph-RAG) — ranking split pinned by drift guard |
| Graph health | ✅ graphHealth + healGraph (auto-heal, scoped) — now also as `graph_health` TOOL in the hub |
| Hub ownership | ✅ all 6 agent-facing knowledge tools live here (zk_extract/zk_card/zk_ask/zk_ingest + migrated knowledge_query/graph_health); power-tool reverse-dep removed |
| Self-cleaning | ✅ smart pipeline (#345): auto-trigger → converge → merge/purge |
| Feature metadata | ✅ P1 (#349): callouts/tasks/embeds → ranking + context |
| Semantic blend | ✅ CLOSED (#341): retired from default path, opt-in only |
| Docs | ✅ ARCHITECTURE / DEPENDENCIES / DATA-MODEL / PR-HISTORY + symmetric KNOWLEDGE-LAYER.md |
| Tests | 199 pass / 0 fail (pi-knowledge-card); 248 (cli); 294 (power-tool) |

**Open (deferred with reopen-conditions):** kg-plan P2 (fingerprint — reopen at
~4000+ cards), P4 (reindex sync — COLLAPSED unless P3 reopens), P6
(hierarchical-tag flattening — DROP, measured 0.4%). See
[`kg-improvement-plan.md`](./kg-improvement-plan.md).
[`kg-improvement-plan.md`](./kg-improvement-plan.md).
