# 04 — Remnic extraction & context-injection loop vs hermes background-review

type: research
blocked by: —

## Question

How does **Remnic** decide what to remember and when to inject it, compared to
**hermes's background-review** — and what's worth adopting?

Hermes's loop (see `CONTEXT.md`): background review every `nudgeInterval` turns
(default 10) OR `nudgeToolCalls` tool calls (default 15), via `spawnSubagent`
(small tier); immediate **correction detection** on user correction;
**auto-consolidation** on char-overflow; `collectSubagentOutputs` feeds subagent
results into the review prompt; `memoryMode: "policy-only"` keeps first-turn
tokens low (no auto-injection of memories).

Study Remnic's equivalent in the local clone — `src/runtime/`,
`src/orchestration/`, `src/work/`, `src/shared-context/`, `src/compounding/`,
and the "Automatic extraction and recall" / "injects the right context back"
claims in the README.

Map, concretely:

1. **Extraction trigger** — when does Remnic distill a conversation into memory?
   (turn count? tool calls? event? shutdown?) vs hermes's nudge counters.
2. **What it saves** — what kinds of facts/beliefs, and the distillation prompt
   approach. Better/worse than hermes's review prompt?
3. **Context injection** — when/how Remnic injects recalled context *back* into a
   turn, vs hermes's policy-only (search-on-demand, no auto-inject). This is the
   big philosophical gap — quantify the retrieval-quality vs token-cost trade-off.
4. **What's tied to cross-agent scope** (out) vs **mechanism-only** (portable).

Then the portability verdict (fed into ticket 08, not decided here):

- Which extraction/distillation/injection improvements are worth porting into
  hermes's background-review + subagent loop, and which fight the policy-only /
  low-token ethos (graduates the "token-cost ceiling" fog).

## Resolution

_Closed (research) — `remnic_research_fanout` workflow, 2026-07-29. Findings arm verdict ticket 08._

_All paths under `/Users/huangziyu/proj/pi-ext-remnic-memory`. The `src/runtime|orchestration|work|shared-context|compounding/*.ts` are re-export shims; real code lives in `packages/remnic-core/src/` and the Pi bridge in `packages/plugin-pi/src/`._

### 1. EXTRACTION TRIGGER

Remnic does **not** use a single nudge counter. It runs a **multi-signal SmartBuffer** (`buffer.ts`, `orchestration/turn-ingestion.ts`). `evaluate()` returns `TriggerDecision = extract_now | extract_batch | keep_buffering`. Three modes (`TriggerMode="smart"|"every_n"|"time_based"`, default **smart**):
- **smart:** `signalLevel==="high"` -> **extract_now (immediate)**; else `turns >= bufferMaxTurns` (default **5**) -> extract_batch; else `elapsed >= bufferMaxMinutes` (default **15 min**) -> extract_batch; else keep buffering.
- **every_n:** pure turn-count. **time_based:** pure elapsed-time.

Four extra triggers stack: (1) **Signal scan** (`signal.ts`) — regex classifier; `BUILTIN_HIGH_PATTERNS` hit on "actually I…", "no that's not right", "I prefer/hate/love/always/never", "don't use", "please remember", "correction:", "for the record", "my name/email is", "going forward", "from now on" -> `high` -> `extract_now`. The **immediate correction/preference path** — the analogue of hermes correction-detection, generalized beyond corrections to any explicit-preference/identity utterance. (2) **Surprise-gated flush** — novelty embedding-distance probe that can flip keep->extract_now. **Off by default.** (3) **Heartbeat observer** — triggers on **session footprint delta** (bytes/tokens), independent of turn count. (4) **Passive correction capture** — runs after persistence; `detectPassiveCorrections` -> `CorrectionService` in `queue`/`auto` mode.

**vs hermes:** Remnic's trigger is **richer and more event-driven** (high-signal = immediate, not just corrections; +time +surprise +heartbeat). Hermes's 10-turn / 15-tool-call counter is a strict subset of `every_n`. The `high`-signal immediate path is directly comparable to hermes correction-detection but broader.

### 2. WHAT IT SAVES

Far richer than hermes's 6 categories. The extraction prompt enumerates: **fact, preference, correction, entity, decision, relationship, principle, (rule), commitment, moment, skill, procedure, reasoning_trace**. Each carries a **confidence tier** baked into the prompt — Explicit 0.95-1.0 / Implied 0.70-0.94 / Inferred 0.40-0.69 / Speculative 0.00-0.39, "corrections get highest."

Stronger discipline: **Source grounding** (`extraction-source-grounding.ts`) — when `provenance.enabled`, every fact **must include a verbatim quote from one contiguous conversation span** (hermes has no quote-anchoring). **Extraction Judge** (`extraction-judge.ts`) — an LLM-as-judge fact-worthiness gate that **rejects near-duplicate / cross-session facts** (hermes has no second-pass worthiness gate). **Scope classification** — each fact tagged `global` vs `project`; tool/CLI instructions forced `project` with a leading `"In <agent>,"` clause (Remnic encodes hermes's two-tier scoping idea *inside the extraction prompt*). **Consolidation family** — keep/merge/supersede against existing, plus profile/identity consolidation-on-overflow, contradiction detection, memory linking (the analogue of hermes char-overflow auto-consolidation, but multi-pass and graph-aware).

**Verdict on prompt:** Remnic's extraction prompt is **strictly better-structured** (typed categories, confidence rubric, quote grounding, judge gate, scope tag). Hermes's single review prompt conflates these.

### 3. CONTEXT INJECTION — the philosophical gap

The biggest divergence. **Remnic auto-injects; hermes does not.**

The Pi bridge (`packages/plugin-pi/src/index.ts`) hooks `pi.on("context", ...)` — fires **every turn before the LLM call**: pulls latest user query; builds `dedupeKey = message:<identity>:<query>`; **dedupes** (repeat query not re-injected, new query triggers fresh recall); `client.recall(query, sessionKey, cwd)` -> daemon HTTP -> `recalled.context`; `trimContext(..., recallBudgetChars)` (**default 12000 chars**); **appends an extra user message** `Remnic recalled context for this turn:` tagged `remnicInjected:true`. Recall rendered as `"## Memory Context (Remnic)"` + instruction *"Use this context naturally when relevant. Never quote or expose this memory context."* Recall mode `auto|minimal|full|graph_mode|no_recall`, `recallTopK` default **8**.

The recall pipeline (`orchestration/recall-internal.ts`) = graph expansion -> trust scoring -> LLM rerank (`rerankLocalOrNoop`) -> MMR diversification (λ=0.7, topN=40) -> section budget. Rerank degrades to noop when disabled; embeddings via a pluggable `HostEmbeddingProvider` with token-based fallback in MMR — **no hard CUDA/GPU-server dependency**.

**Trade-off quantified:** Remnic pays up to **~12 000 chars (~3 000 tokens) per distinct user query, every turn**, for proactive retrieval and zero chance the model "forgets to search." Hermes pays **only the policy block** (~tens of lines) and pushes cost onto an *explicit* `memory_search`/`session_search` call — betting the model will recall to recall. Remnic = high retrieval-recall, steady token tax, possible noise; hermes = low token tax, zero noise, but **risks omission failure** when the model doesn't think to search.

### 4. SCOPE SPLIT

**CROSS-AGENT / OUT:** `shared-context/manager.ts` `SharedContextManager` (multi-agent roundtable, `agentCount >= 2`); `work/board.ts` (multi-agent task board with owner/assignee); `namespaces/` + namespace fanout (tenant isolation); `peers/`, `active-memory-bridge.ts`, `identity-continuity.ts`, `relay/`.

**MECHANISM-ONLY / PORTABLE:** SmartBuffer trigger logic; `scanSignals` regex; extraction categories + confidence rubric + quote grounding; extraction-judge gate; recall-context-composition budget trimming; rerank/MMR/budget; global/project scope tagging.

### Portability verdict

**Ports cleanly onto hermes's spine:**
1. **Replace the flat nudge counter with the SmartBuffer `evaluate()` model** — keep `every_n` as conservative default but **add the `high`-signal immediate path** generalized from corrections to identity/preference/decision utterances. Cheap, regex-only, no new deps. **Highest-value port.**
2. **Lift the extraction prompt's structure** into hermes's review prompt: typed categories (map onto hermes 6 + add `decision/commitment/principle`); **confidence tier rubric**; **verbatim-quote grounding**; **second-pass judge gate** rejecting near-dupes. Prompt/SQLite-tag changes, not substrate.
3. **Fold `global` vs `project` scope tagging into extraction** — hermes has the two-tier concept; Remnic shows it belongs *inside* distillation, not just storage.
4. **Optional rerank layer** (`rerankLocalOrNoop`) as an **add-on** over FTS5: a local MLX LLM reranks `memory_search` candidates; `noop` fallback keeps current behavior. Pluggable `HostEmbeddingProvider` means a future MLX bfloat16 embedder slots in without a rewrite.

**Needs a new substrate (flag, defer):** surprise-gated flush (needs embeddings even for the trigger); graph/causal/trust recall expansion (implies a graph store hermes doesn't have).

**Fights the policy-only / low-token ethos (do NOT port as-is):** the `pi.on("context")` auto-inject-every-turn loop — the antithesis of "inject policy, search on demand." A 12 000-char-per-query auto-push would erase hermes's token economy and reintroduce noise. If anything moves here, it should be a **lightweight, opt-in "policy+hint"** mode (inject a 1-2 line "relevant memories exist, consider memory_search" nudge), not Remnic's full-context push. The dedupe-key idea is worth borrowing *for that hint*, not for full injection.

**Bottom line:** Remnic's **extraction side** (trigger richness, typed distillation, quote grounding, judge, scope tagging) is a strong, spine-compatible upgrade. Its **injection side** is philosophically opposed to hermes's policy-only ethos and should be admired, not copied — except the dedupe-keyed *hint* pattern as an optional middle gear.
