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
  recalibration (floor=1 → 5/14 inject, block p95 360 — at the cap edge, within the
  cap+40 chrome allowance; reviewer-reproduced), a CJK-aware minPromptChars (40 CHARS
  gates out typical zh questions ~20 chars — 2/10 substantive prompts failed purely on
  length), or t16's end-task delta. Three operational findings recorded in the map Context:
  cold-start silent no-op (first semantic call pays bge-m3 load > 3 s timeout), the
  vault-resolution trap (personal-config vault wins the ladder — probe from a repo cwd
  resolved to `study-news`, whose generic page cards scored sharedTags 0 and the floor
  correctly suppressed everything), and cooldown-silent turns count as non-injected in the
  probe's denominator.
- **D12 — end-task payoff PROVEN (+40pct under floor=0), flip still OFF; scoreFloor is
  structurally lexical (ticket 16, 2026-08-29).** Battery
  `scripts/injection-endtask.mjs` (20 zh-heavy vault-grounded questions + 5 chitchat
  negatives, deterministic grader, serialized headless bonsai-27b `--thinking off
  --tools read`, 43 min, receipt `output/injection-endtask/receipt-2026-08-29T01-57-14-101Z.json`):
  unarmed 4/20 (20%) → armed `KC_AUTORECALL_FLOOR=0` 12/20 (60%), Δ+40pct, ticket gate
  (armed ≥ unarmed) PASS; armed with default gates ≈ the no-op calibration predicts
  (2/20). Calibration: floor 2/1/0 → 1/1/20 injected (target card 20/20 at floor=0),
  block median 318 est-tok, chitchat 0/5. Ships NOW: the CJK-weighted `minPromptChars`
  (each CJK char weighs 2 — t10's 2/10 zh length-misses fixed) and the battery env pins
  `KC_AUTORECALL_FLOOR` / `KC_AUTORECALL_MINCHARS` / `KC_AUTORECALL_TIMEOUTMS`
  (widening-only) + `KC_AUTORECALL_DEBUG` per-turn stderr trace with `trace.error`.
  Stays: `scoreFloor: 2` default — floor=0's precision on OFF-TOPIC substantive prompts
  is unmeasured (negatives are chitchat-only), and `sharedTags` is a lexical-only floor
  (ASCII tag derivation) so zh prompts structurally cannot clear floor≥1 regardless of
  length gating; a semantic-score floor would be retrieval-side surgery (t15 territory).
  Flip (default ON) additionally requires, in order: the **converge×cache fix** (hermes
  auto-converge touches card mtimes at every session_shutdown; the semantic cache
  fingerprint is name+mtime → per-session 828-card re-embed bursts measured 53 s → the
  injector's 3 s bound is unreachable in real sessions today), the floor=0 precision
  probe, and D11's cache-transition re-probe (floor=0 blocks median 318 > t10's 282).
  Operational: LM Studio :1234 wedges intermittently under load (embeddings >10 s while
  `/v1/models` answers) — silent armed no-ops, detected via `trace.error`; probes must
  never infer from silence. `SEMANTIC_EMBED_BASE` is honored standalone but NOT inside
  the extension-loaded s2-agent child (batteries ride :1234).
- **D13 — t12 used-ledger hotness multiplier: shape reconciled to neutral-at-h=0,
  mechanism PROVEN on the seeded battery, default stays OFF until a real-usage battery
  (ticket 12, 2026-08-29).** The t11 USED ledger (`.knowledge-usage.jsonl`) feeds
  retrieval via `src/feedback/hotness-feed.ts` (per-uri replay mirroring
  `usageAggregates`' shape) + `RetrieveOptions.hotness` / `usageLedgerPath`. The
  ticket's prose multiplier `score × (0.9 + 0.2·h)` contradicts its own acceptance
  criteria (stale decay → 1.0, never-used unaffected/byte-identical): a literal map
  sends both to 0.9 (punitive, never neutral). Implemented `m(h) = 1 + 0.1·h` —
  neutral at h=0, reward-only, [1.0, 1.1] inside the D8 [0.9, 1.1] envelope; on the
  flat lane's integer-ish scores a 1-tag gap (ratio ≥ 3/2 vs m ≤ 1.1) is never
  displaced, and on the semantic rank-norm pool the 12/11 ≈ 1.091 rank gap holds
  against h(2, fresh) = 1.086 (pinned by test). Applied on flat + semantic lanes
  BEFORE the top-K cut; the hier lane applies it POST-CUT on the hydrated top-K
  (reorders within the served set only — honest limitation, cannot pull a hotter card
  in from outside the cut). Eval receipt (2026-08-29, real vault, live bge-m3,
  `output/recall-audit/t12-*.json`): baseline 11/20 hit@1 · 16/20 hit@3 · 17/20
  hit@5 · MRR 0.688 (reproduces the t04 receipt exactly); seeded-targets ON
  15/20 · 17/20 · 17/20 · 0.792; non-targets noise control byte-identical to
  baseline. Mechanism proven — used-and-recent ranks up, usage noise moves nothing —
  but the targets arm is CIRCULAR by construction (answer keys seeded) and the
  production ledger is still EMPTY (t11 shipped 2026-08-28; no live rows on this
  machine yet), so D8's promotion gate ("beat the count baseline on the eval set")
  is NOT met by a seeded run: default stays OFF. Re-eval trigger = a populated
  production ledger (weeks of real use rows), then re-run the battery UNSEEDED
  comparing hotness on/off. Decay is asymptotic: m > 1 strictly for any finite age,
  so a stale-used card can still flip an exact tie (bounded by the 7d half-life —
  90d ⇒ m−1 < 1e-4, pinned by test).

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
