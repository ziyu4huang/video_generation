---
type: research
blocked by: []
status: closed
resolved: 2026-07-31 (13 ecosystem candidates surfaced — CAVEAT: live web_search unavailable; framework-level, URLs unverified)
---

# 03 — Ecosystem / competitor feature scan (subagent + workflow)

## Question

What **feature gaps** surface from the broader ecosystem — capabilities peers/pi
ecosystem have that our subagent + workflow do not?

## Resolution (researched 2026-07-31, branch behind:0)

> ⚠️ **EVIDENCE CAVEAT — read before scoring.** Live `web_search` was
> **unavailable** in this charting session: Zai MCP returned
> `search_query cannot be empty` (wrapper bug), Exa hit free-tier rate-limit
> (429), and Brave/Tavily/OpenAI have no API keys configured here. "Our status"
> lines ARE verified against repo source; "gap" citations are **framework-level
> knowledge, not freshly-verified URLs**. **Ticket 04 MUST re-run ecosystem
> queries with working search keys before final do/defer/skip scoring** of these
> candidates. (Queries to re-run are listed at the bottom.)

### Candidates (axis: `ecosystem`)

1. **Machine-readable event/streaming surface for observability.** Gap: peers
   emit structured events for external tracing — Claude Code `--output-format
   stream-json` (`assistant_response`/`tool_use`/`result` events, hooks),
   LangGraph streaming modes (`values`/`updates`/`messages`/`custom`), OpenTelemetry
   GenAI semantic conventions (LangChain/LangGraph/AutoGen export OTel spans);
   Cursor/Devin have web dashboards. Ours: rich INTERNAL UI (`task-panel`
   tokens/cost + live tps, `subagent-progress-widget`, throttled history, TUI
   viewer) but **no stream-json / OTel / event-emitter** an external consumer
   (Langfuse/Phoenix/Honeycomb) can subscribe to; cost is computed
   (`workflow.ts:496`) but shown, not exported. Shape: optional `eventStream`/OTel
   exporter (one span per `subagent`/`agent()` call) + stream-json for headless.
   Verdict hint: `genuinely-missing`. *(highest leverage)*
2. **Run-wide $ cost cap + persistent cost ledger.** Gap: Temporal/Airflow spend
   SLAs; Dagster per-asset cost; LangChain billing & Langfuse $-per-trace +
   budget alerts. Ours: per-agent `$` cap exists (`spendBudget` `agent.ts:289`)
   but run-wide cap is **token-only**; no run-level `$` knob, no cross-run/pack
   ledger, no alerting. Shape: run-level `spendBudget` + per-pack persisted ledger
   (`~/.pi/workflows/.../costs.jsonl`, MTD totals, threshold hook). `genuinely-missing`.
3. **Per-agent/per-phase retry policy w/ backoff + non-retryable classification.**
   Gap: Temporal `RetryOptions{maximumAttempts,backoffCoefficient,maximumInterval,
   nonRetryableErrorTypes}`; Airflow `retries`/`retry_delay`/
   `retry_exponential_backoff`; LangGraph per-node retry. Ours: flat global
   `agentRetries` + `retryOnTransient`=**one** retry; no exp backoff/jitter, no
   per-call config, no non-retryable allowlist. Shape:
   `agent(p,{retry:{attempts,backoff,maxMs,jitter,nonRetryable}})` honoring
   `retry-after`. `genuinely-missing`.
4. **Rate-limit-aware (RPM/TPM token-bucket) concurrency scheduler.** Gap:
   LiteLLM router RPM/TPM budgets; provider `retry-after`/
   `x-ratelimit-remaining-*` headers; LangGraph/CrewAI rate-aware queues. Ours:
   concurrency = `hwConcurrency-2` naive count (`workflow.ts:325`); 429 retried
   once but scheduler **doesn't read rate headers / apply a per-model bucket** →
   heavy fan-out to a rate-limited provider just 429s repeatedly. Shape:
   per-(provider,model) token-bucket limiter in the parallel runner. `genuinely-missing`.
5. **Process-global concurrency governor across background runs.** Gap:
   Devin/Cursor per-account agent caps; Temporal worker concurrency; Airflow pool
   slots. Ours: each background run gets its own `concurrency`; N concurrent
   `/workflows` runs → N×concurrency agents → thrash; grep for `semaphore`/
   `globalConcurrency` in workflow `src/` = **empty**. Shape: process-global
   agent-slot governor shared by `subagent` tool + `parallel()` + background runs.
   `genuinely-missing`. *(high leverage)*
6. **Workflow pack self-eval fixtures / golden trajectories.** Gap: SWE-agent/
   SWE-bench replay+scored eval; LangSmith datasets+evaluators; CrewAI
   `training=True`. Ours: PRD lists "**north star self-improve loop (deferred)**";
   `version` manifest field is "groundwork for the deferred loop" — but **no
   fixture/eval harness** to score a pack deterministically. Shape: pack-local
   `eval/` (golden inputs + pass/fail), `workflow pack eval` cmd, score on run
   record. `genuinely-missing`. *(high leverage — serves north star)*
7. **Frozen-fixture / record-replay mode pinning agent outputs.** Gap: VCR/
   nock/Polly.js cassettes; LangSmith playground replay; Temporal deterministic
   replay. Ours: orchestration is hermetic/deterministic (`SafeDate`, no
   `Math.random`/`require`/`fs`/net in vm, `workflow.ts:281`) but agent OUTPUTS are
   live/non-deterministic — no record→replay mode (would make #6 reproducible +
   CI hermetic). Shape: `record`/`replay` flags pinning the journal as output
   source for matching `agent()` call-indexes. `genuinely-missing` (enables #6).
8. **Non-determinism / journal-divergence detector.** Gap: Temporal
   non-deterministic-workflow detection; LangGraph hash-checkpoint drift. Ours:
   journal does longest-unchanged-PREFIX replay (`workflow.ts:442`); a script edit
   mid-run silently re-runs the suffix — we **don't detect/warn** that a re-run's
   resolved call-stream diverges. Shape: hash resolved (callIndex→prompt+opts) at
   start; on resume assert equality, surface `journal-divergence`. `genuinely-missing`.
9. **Crash-recovery lease TTL/reclaim.** Gap: Temporal sticky-queue + heartbeat
   lease; Postgres advisory-lock TTL; LangGraph Postgres checkpointer. Ours:
   cross-process lease exists (`run-persistence.ts:114`), graceful `usage_limit`
   pause/resume works — but a **hard kill** leaves the lock file → resume blocked
   until manual cleanup; no TTL/reclaim. Shape: monotonic mtime + heartbeat;
   `acquire` may reclaim past TTL after a grace period. `genuinely-missing` (small).
10. **Cross-run prompt-dedup / response cache.** Gap: AutoGen Redis cache;
    LangChain cache (SQLite/Redis/upstash); CrewAI `@cache`. Ours: journal caches
    WITHIN one run; identical prompts across separate runs re-pay every time.
    Shape: opt-in content-addressed cache keyed `sha256(prompt+model+tier+schema)`,
    per-pack, `cache:'on'|'bypass'|'write'` flag. `genuinely-missing`.
11. **Workflow pack registry / hub (discovery + install).** Gap: LangChain Hub;
    CrewAI templates; n8n marketplace; Dify workflows. Ours: local tiers
    (cwd→binDir→`.pi/workflows`→package-local, ADR-0003); upstream
    `npm:@quintinshaw/pi-dynamic-workflows`; **no registry** to browse/install
    third-party packs by name. Shape: `workflow pack install <name>` against a
    registry index w/ manifest provenance. `genuinely-missing`.
12. **Composite / nested workflow packs (child workflows).** Gap: Temporal child
    workflows; Airflow SubDag/TaskGroup; LangGraph subgraphs; Dagster
    graph-backed assets. Ours: flat — `agent()` spawns one child LLM session; a
    workflow can't invoke ANOTHER workflow as a resumable subgraph. Shape:
    `runPack(name,args)` mounting a pack as a journaled sub-run under the parent
    phase tree. `genuinely-missing`.
13. **Subagent auto-surfacing of pi skills / MCP tools.** Gap: Claude Code
    subagents compose `.claude/skills/*` + MCP; LangChain/LangGraph/Cursor
    compose dynamically. Ours: children get `createCodingTools(cwd)` + engine
    tools; PRD explicitly "no second tool registry; no skills/`ToolSearch`"
    (different-by-design for the engine) → a child can't opt into a pi skill or
    MCP tool even when useful. Shape: per-agent `includeSkills`/`includeMcpServers`
    (contingent on pi exposing skill/MCP factories). Verdict hint:
    `different-by-design` BUT real surface gap → defer, re-evaluate if pi lands a
    stable skill/MCP API.

### Different-by-design (defer — not do-candidates)

Cloud/remote execution (D-1, local-first); container isolation (D-2, worktree by
design); free-form multi-agent handoff (D-3, deterministic JS orchestration);
persistent semantic memory in subagents (D-4, owned by hermes-memory/zk — stateless
by design); pi skills/`ToolSearch` in engine (D-5, PRD); browser/computer-use (D-6,
web-access ext covers it); dynamic runtime fan-out (D-7, loops approximate);
reflexion primitive (D-8, `gate`/`retry`/`adversarial-review` approximate).

### Queries to re-run in 04 (live search keys required)

`"pi.dev pi-coding-agent extensions"` · `"@earendil-works pi-coding-agent workflow
pack examples"` · `"Claude Code subagents stream-json hooks 2025"` ·
`"LangGraph streaming checkpointer interrupt"` · `"OpenTelemetry GenAI semantic
conventions"` · `"Temporal retry policy nonRetryableErrorTypes"` ·
`"LangChain cache CrewAI templates registry"` · `"SWE-agent eval replay fixtures"`.

**Note for 04:** highest-leverage = #1, #2, #5, #6, #10 (observability + cost +
parallelism-safety + eval, all serving the deferred self-improve north star + real
production pain). #3/#4 = reliability hardening. #7/#8/#9 = determinism. #11/#12 =
ecosystem growth. **Verify every citation before scoring.**
