# 08 — Verdict + port-design: extraction/distillation loop

type: grilling
blocked by: 01 — Ranking criteria for the improvement spec, 04 — Remnic extraction & context-injection loop vs hermes background-review
claimed: wayfind (claude, 2026-07-29, session 4)

## Question

Given the **ranking criteria** (01) and the **extraction-loop deep-dive** (04):
which extraction / distillation / context-injection improvements go INTO the spec
vs DEFERRED vs OUT?

The central tension to resolve with the human: Remnic **auto-injects** recalled
context; hermes is **policy-only** (search-on-demand) precisely to keep
first-turn tokens low. Decide, one sub-question at a time:

- **Trigger/cadence** — is Remnic's extraction trigger better than hermes's
  nudge counters? Worth changing?
- **What it saves / distillation quality** — adopt a better distillation prompt
  or scoring?
- **Context injection** — adopt *any* auto-injection (and pay the token cost), or
  stay policy-only and only improve *retrieval quality* when the agent does
  search (graduates the "token-cost ceiling" fog)?

For whatever's IN, sketch the port-design onto hermes's background-review +
subagent loop, sized for one plan. This becomes the learning-loop section of the
final spec (09).

## Recommended starting point (to be confirmed against 01 + 04)

Likely IN: improve distillation quality + maybe the trigger; likely **stay
policy-only on injection** (hermes's low-token ethos is a feature, and retrieval
improvements from ticket 06 already make on-demand search better). Revisit if 04
shows injection's quality gain dwarfs its token cost. Adjust once 04 lands.

## Resolution

_Closed (grilling) — 2026-07-29, session 4. Accepted recommended verdict. Grounded in the now-current `config.ts` (post-rebase): hermes already has a real extraction loop — `reviewEnabled`/`reviewRecentMessages` + `correctionDetection` + `errorCapture` (extract), `nudgeInterval`/`flushMinTurns`/`flushOnCompact`/`flushOnShutdown` (cadence), `llmModelOverride` (distillation LLM), `failureInjectionEnabled`+age+entries (bounded injection), `autoConsolidate` (dedup/trim). 08 = **upgrade this existing loop**, not build anew. Pins 01's deferred token-cost gate. Becomes the learning-loop section of the spec (09)._

### Verdict (per 01 ranking model: gain × Pi-fit score; effort/token gates; strength tiebreak)

| Sub-question | Verdict | Port-design sketch |
|---|---|---|
| **Trigger/cadence** | **IN (light)** | Hermes already flushes on compact/shutdown + nudges. **ADD: fire an extraction pass immediately when `correctionDetection`/`errorCapture` signals** (signals already exist) — Remnic SmartBuffer-light, **no new detector**. Effort **S**. |
| **Distillation quality** | **IN** | Upgrade background-review prompt to emit **category-typed** entries (hermes's existing categories) **grounded in verbatim session quotes** attached via **06's `sources[]`** (kind=quote, locator=session-ref, capture=text). Reuses `llmModelOverride`/`llmThinkingOverride`. Effort **M**. |
| **Extraction-judge gate** | **IN** | After distillation, before write: judge step (reuse `llmModelOverride`/spawnSubagent — **same pattern as 06's reranker**) scores each candidate 0–100 on relevance/specificity/non-redundancy; drop below `extractionJudgeThreshold` (default 60). Write-side, off first-turn path. Effort **M**. |
| **Scope tagging** | **IN** | Tag entries session/project/global; reuse target routing + `projectsMemoryDir` (**rides parallel T04** project-aware write path — open dependency). Effort **S**. |
| **Context injection** | **policy-only + opt-in hint** | Default stays `policy-only` (0 first-turn tokens). **One concession**: dedupe-keyed **opt-in ≤500-token hint** (one-line), surfaced on a dedupe-key match, **OFF by default** (`hintInjectionEnabled: false`, `hintInjectionMaxTokens: 500`). NO Remnic auto-inject-every-query. |
| **Token-cost ceiling (01's hard gate — PINNED)** | **Pinned** | First-turn injection = **0 tokens**; opt-in hint ≤ **500 tokens**; extraction + rerank LLM = **write/query-side, bounded by cadence + cache, off the first-turn path**, configurable via `llmModelOverride` (small tier OK). |

**OUT:** Remnic auto-injection (12k chars/query — breaks first-turn ethos), cold-builder verification (platform), extraction X-ray observability (defer — diagnostic, not v1).

**Reconciliation:** reuses 06's `sources[]` (quote grounding) + 06's judge pattern (reranker/extraction-judge = one seam). Extraction writes ride the standard memory-tool path made project-aware by parallel T04 (open) — flag the dependency for writing-plans. The token gate is the **spec's hard ceiling**: any future injection proposal must show first-turn delta = 0 (or opt-in ≤500t).

**Ranking (per 01):** extraction upgrades = high gain (better distillation → better store → better recall) × high Pi-fit (upgrade existing loop; reuse `llmModelOverride` + 06 `sources[]` + judge pattern) → IN. Injection stays policy-only × hermes-strength-fit (low first-turn tokens) → defining ethos; opt-in hint is the only bounded concession. Token gate satisfied.
