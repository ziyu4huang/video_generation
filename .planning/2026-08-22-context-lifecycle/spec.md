# Spec — context-lifecycle (2026-08-22)

Full rethink of the agent context-engineering pipeline behind `./s2-agent.sh`, learning from
OpenViking (`/Users/huangziyu/proj/OpenViking`). Scope packages: `s2-agent-ext-obsidian`,
`s2-agent-ext-knowledge-card`, `s2-agent-ext-hermes-memory`, `s2-agent-core-interface`.
Measured baseline and ticket list live in `map.md`; this file is the target architecture.

## 1. Destination

See `map.md`. One lifecycle, six stages, deterministic-first, all local models, breaking
changes allowed (D0).

## 2. Lifecycle → package mapping

| Stage | Owner | Key files |
|---|---|---|
| Capture | hermes-memory (journal/write path post-fold) + kcard `zk_ingest` | hermes `src/composition/compose.ts`, kcard `src/ingest.ts` |
| Distill | kcard `src/distill/*` + gray-zone ExtractLoop (new) | `distill/{gate,converge,state,threshold}.ts`, `src/llm-chat.ts` |
| Store | obsidian vault (md-git-canonical) + kcard cards/agg nodes, card schema v2 | `src/card-format.ts`, `src/card-render.ts`, `src/hierarchy-build.ts`, `src/aggregation-write.ts` |
| Retrieve | kcard ONLY (single retrieval path) | `src/retrieve.ts` (`retrieveRecords`), `src/semantic.ts` |
| Inject | kcard extension via pi hook (new `src/inject/`) | `extensions/knowledge-card.ts`, `src/inject/auto-recall.ts` |
| Feedback | kcard new `src/feedback/` (hermes donors) | hermes `src/store/heat.ts`, `src/handlers/used-detection.ts` |

Tier boundary preserved: obsidian never imports kcard; kcard→obsidian `src/lib` imports stay
the only cross-edge (ADR-0001 down-only).

## 3. Decisions

- **D0 — breaking changes allowed (a lot) in obsidian + knowledge-card.** User call,
  2026-08-22: better engine > surface stability. Card format, tool surface, caches, pinned
  baselines may break. Every break ships a one-shot migration (script under the owning
  package `scripts/`) or a deliberate baseline regen, and cites D0 in its ticket/commit.
  Hermes (D1) is equally breaking. Non-knowledge extensions and repo-wide gates (local_ci
  ≤5 min) are NOT exempted.
- **D1 — hermes folds to capture-only journal.** Keep: session journal, auto-capture,
  correction detection, session_shutdown flush, `convergeHermesMemory` handoff (ADR-0001),
  deterministic exact-match session search. Retire: the semantic memory-search surface and
  the never-armed vector path (`store/surreal/vector-store.ts`, `vector-store-helpers.ts`,
  `VECTOR_BOOTSTRAP_SQL`, `handlers/vector-backfill.ts`). Recall questions route through
  `knowledge_query` (the agent already holds both tools). Reason: the 2026-08-19 audit
  measured 0/20 — the surface costs schema for zero recall, and re-arming it would duplicate
  kcard's measured 1.00 blend. ADR-hermes rewrite is part of ticket 03.
- **D2 — vault-mind retired.** Delete obsidian `semantic_search` action, `VAULT_MIND_*`
  envs, `maybeTriggerReindex` hook (`src/lib/routing.ts`, `src/lib/subagent.ts`). No local
  fallback inside obsidian — Tier-0 stays lexical+graph; semantic retrieval lives
  exclusively in `knowledge_query`. Net obsidian schema-cost reduction, measured at regen.
- **D3 — canonical embedding = `text-embedding-bge-m3` on LM Studio `http://127.0.0.1:1234`.**
  Reasoning: the vault is Traditional Chinese and MiniLM-class CJK weakness is documented
  in-repo; BGE-M3 measured available on :1234 (probe 2026-08-22, see map Context). The
  kcard cache `<vault>/.knowledge-semantic/<model>.json` is model-keyed → switch is a new
  cache file; the old nomic cache is prunable. **Eval gate**: ticket 07 re-measures hit@4 on
  the existing eval set under BGE-M3; if it drops below the nomic baseline, D3 flips back to
  nomic and the numbers are recorded in map. embed-mlx-server `:8090` is the documented
  fallback endpoint via env override (`SEMANTIC_EMBED_BASE`/`SEMANTIC_EMBED_MODEL` threaded
  through `DefaultEmbedderOptions` + `embedding-leaf.ts`).
- **D4 — card schema v2 (breaking, D0).** Additive-where-possible but migration-backed:
  - `summary:` frontmatter, ≤256 chars — the L0 abstract (written at ingest;
    deterministic first-sentence via `src/extractor.ts`; LLM (`llm-chat.ts`) only when the
    body exceeds a budget — the leanrag-D6 budget-gating pattern).
  - `experience` card kind — Situation/Approach/Reflect body template (OpenViking
    `experiences.yaml` pattern) with `supersedes` lineage reusing `src/supersede.ts`.
    Join the existing `type` enum; no second type system.
  - Typed merge-op table in `src/card-format.ts` (OpenViking merge_ops): `id`/`created`
    immutable; `summary` replace; counter-like fields sum; `sources`/`entities`/
    `tags` patch-union. Consumed by wiki-merge (existing `src/wiki-match.ts`) and the new
    ExtractLoop merge path (D9).
  - One-shot backfill `scripts/` migration stamps `summary:` on existing cards.
- **D5 — L0/L1/L2 tier ladder in retrieval; NO sidecar files.** L0 = `summary:` frontmatter
  (+ title + tags); L1 = agg-node `summary:` + body lead section (~600 chars) for leaves;
  L2 = full body. `RetrievedCard` gains `tier` + pre-rendered per-tier text;
  `zk_card`/`knowledge_query` render L0 default / L1 on detail flag / L2 on explicit
  request. OpenViking's rule adopted verbatim: an entry that overflows its budget demotes to
  a shallower tier instead of being truncated. Sidecar files (`.abstract.md`/`.overview.md`)
  rejected — a third drift surface against leanrag D7 (md-git-canonical, derived
  regen-able); the 2026-08-17 polish just closed drift surfaces, this effort doesn't reopen
  them.
- **D6 — auto-recall injection via `before_agent_start`.** Mechanism proven in-repo
  (ultracode.ts:149; cache-transition 0.98× warm). New `src/inject/auto-recall.ts`:
  1. Deterministic trigger gate — skip when the prompt is short, matches a chitchat vocab,
     or `retrieveRecords` top score < floor. (OpenViking's "0 queries for chitchat" without
     the cloud intent model.)
  2. Retrieve via `retrieveRecords` (the single path), render top-k at L0.
  3. Budget: hard cap 350 tok/turn default; per-entry cap = 2× average share; overflow
     demotes or drops tail.
  4. RecallLedger (session Map, uri → 3-turn cooldown); a no-relevant-result turn injects
     nothing AND records nothing (OpenViking's ledger-poisoning fix).
  5. Child-session guard so spawnSubagent children don't double-inject.
  Shipped off-default (knob); flipped ON only by ticket 10 with measured numbers.
- **D7 — stealth-trim pin: intent overturned, letter kept.** The pin (no tool-schema
  `promptSnippet`/`promptGuidelines`) stays green — hook injection isn't covered by it and
  adds zero schema cost. Its intent ("no per-turn injection from kcard") is deliberately
  overturned by D6; the test's header comment is amended to say so, and a NEW pin replaces
  it: the injector's per-turn token cap is asserted in a test.
- **D8 — feedback = deterministic usage ledger + bounded hotness.** Provenance: (i) turn_end
  scan of assistant text for injected card titles/slugs (port of hermes
  `handlers/used-detection.ts`); (ii) `zk_card` read provenance within the session; (iii)
  `pi:knowledge` bus `used` event (extend `src/emit.ts`). Storage: append-only
  `<vault>/.knowledge-usage.jsonl` (`{uri, at, via}`) — NEVER frontmatter counters, so reads
  leave the git vault clean. Scoring: `src/feedback/hotness.ts` implements
  `sigmoid(log1p(count)) * exp(-ln2 * age_days / 7)` (injected clock); `retrieveRecords`
  applies it as a bounded multiplier ≤ ±10% so feedback re-ranks but never dominates
  lexical/semantic evidence (the IDF-gate lesson, applied).
- **D9 — ExtractLoop dedup, LLM only in the gray zone.** Before any LLM runs, pull top-k
  similar existing cards from the `.knowledge-semantic` cache: cosine ≥ 0.90 → deterministic
  merge (extends the Jaccard-0.85 wiki-aware upsert in `src/ingest.ts`); 0.75–0.90 → ONE
  LLM skip/create/merge decision via `llm-chat.ts`; < 0.75 → create. Merges apply the D4
  merge-op table. Each distill converge run appends `.distill-diff.json` beside
  `.distill-state.json` (created/merged/skipped + per-field ops) — the audit trail.
- **D10 — eval as committed scripts, outside local_ci.** `recall-audit.mjs` (hermes pkg),
  `retrieval-eval.mjs` (kcard), injection probes — all opt-in (`test:eval`-style npm
  scripts); local_ci stays ≤5 min; long probes capped ≤1 h.
- **D11 — injection default stays OFF; the flip gate FAILED on measurement (ticket 10,
  2026-08-29).** `scripts/cache-probe-inject.mjs` (kcard pkg, ultracode cache-probe pattern
  ported) measured on this machine, real vault `pi-agent-vault` (827 cards), LM Studio
  `prism-ml/bonsai-27b` + `text-embedding-bge-m3`: (a) tokens p95 282 tok ≤ 350 cap but
  injection rate only 2/20 scripted turns (10%) — `scoreFloor: 2` suppresses near-perfect
  retrievals (top cards for a hand-written lora/argparse question score sharedTags=1);
  (b) cache-transition injected↔clean = **1.156× warm > 1.05× target** (single-entry KV;
  the block rides the systemPrompt TAIL so the absolute cost is +46 ms/turn at 282 tok —
  small, but the ticket's own gate says no-flip); (c) chitchat skip 20/20 = 100% ≥ 80%.
  `KC_AUTORECALL=1` stays the opt-in knob. Re-probe required after ANY of: floor
  recalibration (floor=1 → 5/14 inject, same p95), a CJK-aware minPromptChars (40 CHARS
  gates out typical zh questions ~20 chars — 2/10 substantive prompts failed purely on
  length), or t16's end-task delta. Three operational findings recorded in the map Context:
  cold-start silent no-op (first semantic call pays bge-m3 load > 3 s timeout), the
  vault-resolution trap (personal-config vault wins the ladder — probe from a repo cwd
  resolved to `study-news`, whose generic page cards scored sharedTags 0 and the floor
  correctly suppressed everything), and cooldown-silent turns count as non-injected in the
  probe's denominator.

## 4. What we deliberately do NOT port from OpenViking

- The Python/Rust server, `viking://` URI virtual FS, AGFS, vector index engine — the
  Obsidian markdown vault stays the store; git stays the transport.
- Cloud rerank (doubao/OpenAI-compatible THINKING mode), cloud intent analysis, cloud VLM
  parsers — no-cloud hard rule; v1 substitutes are deterministic (lexical gate, bounded
  blend) or skipped.
- Directory-drill-down hierarchical retrieval — the LeanRAG agg tree + `expandWithTree`
  already cover the "summary above, detail below" need; a drill-down search engine over a
  few-hundred-card vault would be machinery without measured need (revisit only if ticket
  15 shows tier-ladder recall loss).
- Session-memory type registry / peers / soul-identity memory — hermes' capture format is
  out of scope beyond what the fold keeps; typed memory FILES with per-field merge ops
  arrive via D4's merge-op table on cards instead.

## 5. Eval & verification strategy

Per-phase success criteria (numbers land in map Context/Frontier as they're measured):

- **P0** — post-fold hermes-journal recall via kcard ≥ 1/20 on the committed audit battery
  (old semantic path was 0/20); obsidian schema-cost delta recorded (expected ↓).
- **P1** — hit@4 re-baselined under BGE-M3, gate ≥ nomic baseline (else D3 flips back);
  default-render tokens/card ↓ ≥ 40% vs full body, measured.
- **P2** — tokens-injected/turn p95 ≤ 350; chitchat-probe no_relevant-skip ≥ 80%; local
  cache-transition ≤ 1.05× warm; default flip recorded with numbers.
- **P3** — seeded near-dup corpus: merges hit target, zero false merges on distinct corpus,
  LLM called only in gray zone (counter in test); hotness monotonicity tests; hit@4
  regression-free.
- **P4** — end-task accuracy delta (injection on vs off) on a 20-question probe set; final
  baselines table in map.

Reusable harnesses: `kcard-coverage-measure.mjs`, controlled-corpus, real-retrieval eval
set, the audit-runner pattern from `/tmp/hermes-audit/run-audit.ts`, ultracode cache probes.

## 6. Risks

- **Always-on injection token cost** — cap + gate + ledger + probes before the default flip
  (ticket 10); ultracode precedent shows ~0 cache cost for prefix-stable appends.
- **Largest deletion = hermes fold** — its own PR, pre-census first step, committed
  recall-audit as before/after proof.
- **Pinned-surface flips** — stealth-trim (D7 letter/intent split), hierarchy goldens
  (ticket 06), frozen baselines: each flip cites D0 and is deliberate, never incidental.
- **Local model quality** — deterministic-first everywhere; the only LLM in the loop is the
  gray-zone dedup decision, wrapped by deterministic ≥0.90 and <0.75 paths.
- **Cross-package contracts** — one direction only (kcard→obsidian lib); feedback/ledger
  never leaks into obsidian; GATE_DEFS stays one shared host instance; registry/manifest
  regen on any surface change.
