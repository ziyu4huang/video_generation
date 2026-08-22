---
effort: 2026-08-22-context-lifecycle
created: 2026-08-22
last: 2026-08-23
status: open
pipeline: wayfind→superpowers
---
# context-lifecycle — agent context-engineer pipeline rethink (learn from OpenViking)

## Destination

One measured, deterministic-first context lifecycle for s2-agent, OpenViking-patterned but
local-model-shaped: capture (hermes journal + `zk_ingest`) → distill (state machine +
gray-zone ExtractLoop dedup) → store (card schema v2 + LeanRAG agg tree) → retrieve (single
path through kcard `retrieveRecords`, L0/L1/L2 tier ladder, hotness multiplier) → inject
(`before_agent_start` auto-recall, budgeted, RecallLedger dedup) → feedback (usage ledger →
hotness decay) — with vault-mind retired, hermes folded to a capture-only journal, every eval
harness committed as a script, and breaking changes in obsidian + knowledge-card explicitly
on the table (D0) to get the better engine rather than preserve the old surfaces.

## Context (measured 2026-08-19..23 on this machine)

- **Hermes recall is measured-dead.** Audit 2026-08-19
  (`.planning/knowledge/hermes-recall-audit.md`, runner `/tmp/hermes-audit/run-audit.ts` —
  still uncommitted): hit@1/3/5 = **0/20**, MRR 0.000. The `vectors` SurrealDB database was
  never created, so every query serves the lexical fallback, which returns zero rows for
  natural-language queries. Negatives pass vacuously. The 6-tool schema cost buys zero recall.
- **Embedding endpoints disagree, and the audit misread one.** Live probe 2026-08-22:
  `http://127.0.0.1:8090/v1/models` → 404 (this is what the audit saw) but
  `POST :8090/v1/embeddings` is **ALIVE** and serves `mlx-community/bge-m3-mlx-8bit`.
  `:1234` (LM Studio) simultaneously serves `text-embedding-bge-m3`,
  `text-embedding-nomic-embed-text-v1.5`, `text-embedding-qwen3-embedding-0.6b` plus chat
  models. BGE-M3 is therefore available on BOTH endpoints; nothing qualitative blocks D3.
- **kcard's retrieval already works — measured arc.** `retrieveRecords` hit-rate@4:
  0.48 → 0.80 (bodyMatch) → 0.84 (slugDom) → **1.00 (semantic blend over nomic via LM
  Studio)**; `trySemanticBlend` gracefully falls back to lexical on embed failure. Known
  retrieval weaknesses are documented in-repo: generic-tag noise (`pattern`=282 cards crowds
  specific bridges), batch crowding (maxLinks=8 → 84 intra / 0 external edges), IDF promotion
  gate unmet vs count baseline, graph dilution (three-way 67% < lexical 80% on the
  controlled corpus).
- **The use-side is the hole.** No auto-recall (knowledge reaches the prompt only if the
  model voluntarily calls a zk tool; `stealth-trim.test.ts` pins no per-turn injection), no
  usage signal, no decay. kcard PRD roadmap ③ (knowledge-aware priming) and ④ (learning
  feedback loop) are both still "Planned".
- **The injection mechanism is proven in-repo, not speculative.**
  `s2-agent-ext-ultracode/extensions/ultracode.ts:149` does per-turn conditional
  `before_agent_start` systemPrompt appends; cache-transition cost measured **0.98× warm**
  on local LM Studio/MLX (cache-probe-workflow-local.mjs). The stealth-trim pin only covers
  tool-schema `promptSnippet`/`promptGuidelines` — a hook-based injector keeps its letter.
- **The embedder leaf is already single-sourced.**
  `bun-apps/s2-agent-core-interface/src/embedding-leaf.ts` (`SEMANTIC_MODEL_DEFAULT`,
  `defaultEmbedder`, `DefaultEmbedderOptions`, graceful-degrade) is THE shared leaf since
  polish-L2 (2026-08-17). kcard's embedding cache `<vault>/.knowledge-semantic/<model>.json`
  is keyed BY MODEL → switching canonical model is a new cache file, not a migration.
- **vault-mind retirement measured (ticket 02, 2026-08-22).** Agent schema 22568 → 22235
  tok (−333; obsidian fat tool 156→148, zk_ask 762→437 after its `blend` param died with
  the semantic modes). kcard 4-tool total 2367 → 2019 tok, regression ceiling re-baselined
  ≤2220. Obsidian is hermetic again; zk-ask is lexical+graph only (the retired modes never
  won a regime — iter-6/7 receipts); `retrieval-quality-self-improve.js` retired with them.
- **Schema v2 + backfill measured (ticket 05, 2026-08-22).** Backfill receipt
  (`bun-apps/s2-agent-ext-knowledge-card/output/backfill-summaries/`): 2025 cards / 1925
  active / **1925 stamped, 0 skipped** (81 legacy English-header notes covered by the
  whole-body fallback). Vault diff verified summary-lines-only. Post-backfill recall-audit
  (receipt `output/recall-audit/receipt-2026-08-22T12-41-42-688Z.json`): kcard hit@1 11/20 ·
  hit@3 16/20 · hit@5 **17/20** · MRR 0.688 — identical to baseline; embed text is
  title+tags+body-800 (frontmatter stripped) so `summary` cannot move ranking. Re-embed
  burst = 1925 cards ≈ 2 min on bge-m3. graphHealth findings (34 deadLinks / 140 orphans /
  MOC drift) pre-existing, untouched. obsidian `search-baseline.txt` regenerated (12 snippet
  lines) — deliberate D0 refresh, 370/370 pass.
- **Post-fold recall measured (ticket 04, 2026-08-22).** Committed harness
  `bun-apps/scripts/recall-audit.mjs` (+ battery JSON + CI-safe fixture test in hermes
  `scripts/`, offline via `--test-embedder`). Live receipt 2026-08-22
  (`output/recall-audit/receipt-2026-08-22T11-27-22-314Z.json`): journal arm (folded
  exact-match) **0/20, MRR 0.000** — the audit baseline reproduced, journal is capture-only
  by design; kcard arm (`retrieveRecords` bodyMatch+slugDom+semantic bge-m3, live,
  semanticUsed=true, coverage 20/20) **hit@1 11/20 · hit@3 16/20 · hit@5 17/20 · MRR
  0.688**. This is D1's after-proof: the same question class that scored 0.000 on the old
  hermes recall path now answers 17/20 through kcard. Remaining 3 misses = documented
  generic-tag crowding / twin-card dispersion (ticket 05+ territory).
- **Hermes fold measured (ticket 03, 2026-08-22).** −4,142 net lines / 24 files;
  `knowledge_search` 208 → 171 tok, lexical/tags-only. Gates: hermes suite 1539 pass /
  0 fail, `run-test.sh` ✓, cross-package typecheck ✓, `test:adr` 19 pass. ADR-hermes-
  memory-0002 supersedes the vector-half of ADR-0001. SurrealDB stays as the CRUD journal
  store of record (owner-approved pre-decision). Root schema baseline re-baselined to
  22,529 tok / 74 tools (the +294 vs ticket 02's 22,235 is #1818's `send_message`,
  which landed between the two baselines).
- **OpenViking** (`/Users/huangziyu/proj/OpenViking`, Volcengine, AGPLv3, browsed 2026-08-22)
  is the pattern donor: L0/L1/L2 tier ladder + per-category quotas + breadth-first-then-depth
  budget with demote-not-truncate; RecallLedger cross-turn cooldown with the
  "no_relevant records nothing" fix; `used()` → hotness
  `sigmoid(log1p(active_count)) * exp(-ln2·age_days/half_life)` (7-day); ExtractLoop
  (vector pre-filter → LLM dedup skip/create/merge → typed merge ops → memory_diff audit);
  hook-driven auto-recall/auto-capture; Situation/Approach/Reflect experiences with
  supersedes lineage. Its cloud intent-analysis/rerank/VLM are OUT (no-cloud rule) —
  deterministic-first substitutes or skipped.
- **Tier ladder + D3 re-decision measured (ticket 07, 2026-08-23).** Tokens/card on the
  real vault (258 cards over the 50-query set, receipt `output/tier-ladder/`): L0 65 tok
  vs L2 178 tok avg → **↓63.3%** (target ≥40%). D3 eval gate cut both ways (probe
  `scripts/d3-bge-m3-reeval.mjs`, receipts `output/d3-reeval/`, same-corpus A/B ×2):
  English eval set nomic **48/50** vs bge-m3 **47/50** hit@4 — but the recall-audit
  battery (the binding gate) regresses under nomic **15/20 vs 17/20 hit@5** (MRR 0.564 vs
  0.688), and the prior embed-bench had bge-m3 recall@1 0.909 vs nomic 0.864. **D3 stays
  bge-m3**; the 1-query English-set cost is accepted and recorded. Measurement trap: the
  `SEMANTIC_EMBED_MODEL` env override does NOT reach `getCardEmbeddings` (module constant
  wins unless `semanticModel` is passed per-call) — env-only "model controls" silently
  run the default model. Harness drift-guard regen (D0): first-25 lexical 21/25 → 20/25 —
  tickets-05/06 corpus drift, control-tested on origin/main (identical 20/25); ladder is
  render-only, old-vs-new rankings byte-identical.

## Tickets

Phase P0 — infra unification & hermes triage
- `tickets/01-canonical-embed-bge-m3.md` — task, **closed 2026-08-22** — one canonical embed endpoint/model
- `tickets/02-vault-mind-retirement.md` — task, **closed 2026-08-22** — delete `semantic_search` + VAULT_MIND
- `tickets/03-hermes-fold-capture-only.md` — task, **closed 2026-08-22** — hermes folds to capture-only journal (SurrealDB = CRUD journal store of record, pre-decision)
- `tickets/04-recall-audit-script.md` — task, **closed 2026-08-22** — committed audit harness + post-fold baseline (kcard 17/20 hit@5, journal 0/20)

Phase P1 — card schema v2 + tiered retrieval
- `tickets/05-card-schema-v2.md` — task, **closed 2026-08-22** — summary L0 + experience kind + merge-op table shipped; real-vault backfill 1925/1925 active cards (vault PR #20), recall-audit unchanged (hit@5 17/20, MRR 0.688)
- `tickets/06-agg-node-abstracts.md` — task, **closed 2026-08-23** — agg `summary:` L1 (frontmatter, ≤256) + deterministic top-entity composition (wikilinks unwrapped) + checkpoint v2 + filename child links; FIRST real build: 326 agg nodes / 4 layers / 10 LLM calls over 1921 cards (vault PR pi-agent-vault#21); recall-audit unchanged (hit@5 17/20, MRR 0.688), graphHealth deadLinks 34 == baseline
- `tickets/07-tier-ladder-retrieval.md` — task, **closed 2026-08-23** — `RetrievedCard.tier`+`tiers` (L0/L1/L2 pre-rendered, `src/tier-ladder.ts`), demote-not-truncate everywhere (digest, knowledge_query, zk.retrieve, buildRagTask Step 4); tokens/card ↓63.3% (65 vs 178 tok, receipt `output/tier-ladder/`); D3 re-confirmed bge-m3 (see Context); recall-audit unchanged (hit@5 17/20, MRR 0.688)

Phase P2 — injection loop + ledger
- `tickets/08-auto-recall-injector.md` — task, **open** — before_agent_start budgeted injection
- `tickets/09-recall-ledger.md` — task, **open** — session cooldown, no_relevant records nothing
- `tickets/10-injection-probe-and-flip.md` — task, **open** — measure, then flip default ON (risky)

Phase P3 — feedback + extraction upgrade
- `tickets/11-usage-ledger-detection.md` — task, **open** — three provenance sources → usage jsonl
- `tickets/12-hotness-scoring.md` — task, **open** — bounded hotness multiplier in retrieval
- `tickets/13-extractloop-dedup.md` — task, **open** — vector pre-filter + gray-zone LLM dedup
- `tickets/14-memory-diff-audit.md` — task, **open** — .distill-diff.json per converge run

Phase P4 — eval harness + closeout
- `tickets/15-retrieval-eval-harness.md` — task, **open** — one-command eval, bge-m3 vs nomic A/B
- `tickets/16-injection-endtask-eval.md` — task, **open** — end-task accuracy, injection on/off
- `tickets/17-docs-closeout.md` — task, **open** — CONTEXT/ADR/KNOWLEDGE-LAYER truth

## Decisions

Recorded in full in `spec.md` §Decisions. The ones that shape the architecture:

- **D0 — breaking changes allowed (a lot) in obsidian + knowledge-card.** Card format, tool
  surface, caches and pinned baselines may break; each break ships a one-shot migration or a
  deliberate baseline regen citing D0. Hermes fold (D1) is also breaking. Without this the
  engine design keeps accreting around the 2026-08-17 polish's "zero behavior change" fence.
- **D1 — hermes folds to capture-only journal.** Recall routes through `knowledge_query`;
  the never-armed vector path is deleted, not re-armed. Extends ADR-0001 (hub-owned
  convergence) to recall. Justified by the 0/20 audit — a second retrieval path that returns
  nothing is schema cost, not redundancy.
- **D3 — canonical embedding = BGE-M3 on LM Studio :1234.** The vault is Traditional
  Chinese; MiniLM-class CJK weakness is documented in-repo. Cache is model-keyed so the
  switch is cheap; the eval gate (re-measured hit@4 ≥ nomic baseline, numbers in map) is the
  safety net, with nomic as the recorded fallback.
- **D5/D6 — tier ladder + budgeted auto-recall, deterministic-first.** No LLM intent
  analysis, no local rerank in v1 (OpenViking's are cloud). The lexical trigger gate stands
  in for intent analysis; the 350-tok cap, per-entry 2×-average-share rule, RecallLedger and
  no_relevant-skip stand in for the context assembler.
- **D8 — feedback re-ranks, never dominates.** Hotness enters `retrieveRecords` as a bounded
  ≤±10% multiplier; the IDF-promotion lesson (a scoring change must beat the count baseline
  on the eval set before it defaults) applies to it too.

## Frontier

`tickets/08-auto-recall-injector.md` — ticket 07 closed 2026-08-23 (`RetrievedCard.tier` +
`tiers` L0/L1/L2 pre-rendered text with demote-not-truncate across digest / knowledge_query
/ zk.retrieve / buildRagTask; tokens/card ↓63.3%; D3 re-confirmed bge-m3 after a genuinely
two-sided eval — English set favored nomic 48/50 vs 47/50, the binding recall-audit battery
broke under nomic 15/20 vs 17/20). Ticket 08 is next because retrieval now HANDS the
consumer a budgeted tier ladder, but nothing injects it: knowledge still reaches the prompt
only if the model voluntarily calls a tool. The proven `before_agent_start` hook seam
(ultracode, 0.98× warm cache) + ticket 07's `renderTier(tiers, tier, callerBudget)` is
exactly the injector's context-assembly primitive.

## Fog of war

- Whether `before_agent_start` fires inside `spawnSubagent` child sessions (double-inject
  risk) — one-line probe before ticket 08; the child-guard flag is designed regardless.
- `turn_end` payload shape at the extension layer (assistant text surface unverified) —
  ticket 11 opens with a probe; zk_card provenance works even if turn_end doesn't.
- One-time re-embed burst when card `summary:` backfill touches every card — MEASURED in
  ticket 05: 1925 cards, ~2 min rebuild, ranking byte-identical. Closed.
- BGE-M3 vs nomic head-to-head: the hermes embed-bench already measured bge-m3 recall@1
  0.909 vs nomic 0.864 (hermes PRD; surfaced when ticket 01 landed) — supportive of D3 but
  on a different corpus; ticket 15's A/B on the real eval set is still the deciding receipt,
  and D3 flips back if ticket 07's gate fails.
- Hermes fold blast radius (tools/tests referencing the semantic surface) — census is ticket
  03's first step, not charted here.
- End-task effect of injection is unknown by construction — retrieval hit@k measures
  retrieval, not task success; ticket 16 exists because this cannot be known in advance.
- Charted-but-rejected: OpenViking sidecar files (`.abstract.md`/`.overview.md`) — new drift
  surface vs D7 md-git-canonical (rejected in D5); cloud rerank/intent/VLM (no-cloud rule);
  re-arming hermes `card_vectors` (D1 rationale).

## Cross-effort links

- **Builds-on**: `.planning/2026-08-16-leanrag-hierarchy-port` — its agg-L* tree + DI'd
  summarizeFn/budget gates (D2/D4/D6) become the L1 tier of this effort's ladder; its D7
  (md-git-canonical, derived regen-able) is why OpenViking sidecars were rejected here.
- **Builds-on**: `.planning/2026-08-17-knowledge-pipeline-polish` — its L2 leaf-hoist
  (`embedding-leaf.ts`) is the single point D3 changes; its "zero behavior change" fence is
  exactly what D0 lifts for this effort.
- **Builds-on**: `.planning/knowledge/hermes-recall-audit.md` — the measured 0/20 that
  justifies D1; ticket 04 commits its runner so the number stays reproducible.
