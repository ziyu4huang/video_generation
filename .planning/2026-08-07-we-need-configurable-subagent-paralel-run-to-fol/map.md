---
status: active
---

## Destination

Parallel subagent/workflow dispatch never exceeds the GLM (Zhipu) Pro rate limit. A single, config-driven, per-provider concurrency cap — acquired by BOTH the `subagents` and `workflow` tools — bounds combined in-flight model calls so fan-out can't burst past the limit and crash. Sized to the GLM Pro numbers; no-op until configured; always-on once set.

## Notes

**Domain:** pi-agent-ext-subagent (`subagents` batch tool — per-batch `runWithConcurrency`, default 4, hardcoded `DEFAULT_BATCH_CONCURRENCY`) + pi-agent-ext-workflow (`workflow` tool — per-run-tree `createLimiter` counting semaphore, default `hardwareConcurrency-2`). The two limiters are DISJOINT (no shared state) — the root cause of combined over-limit. The model HTTP fetch is in pi CORE (`@earendil-works/pi-ai`, read-only) — NOT editable here; the cap must live at the orchestrator layer (a shared semaphore both paths acquire). Singular `subagent` is sequential (concurrency-1) — safe, out of scope. The GLM budget is per-API-key across worktrees/sessions → the cap must be a process-global per-provider singleton (sibling to the existing in-flight registry).

**Settled design (from charting grilling):**
- Cap model: concurrency cap (shared counting semaphore, max-N concurrent per-provider) — v1. RPM/TPM token-bucket is the accurate follow-on (fog).
- Config home: `~/.pi/workflows/settings.json` -> `rateLimits: { "zai": { maxConcurrent: N } }` (provider-keyed; co-located with the existing `defaultConcurrency` knob; both tools already read workflow-settings).
- Apply mode: always-on when configured — set the number once; both tools auto-clamp; no-op until configured (current behavior until opt-in via config).

**Skills/procedure:** wayfinder (`bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md`); SpawnFn-injection testing pattern (see ci-recipe.test.ts); local-CI gate (`bun run check` + `bun test` per changed package).

## Decisions so far

- [02 — rateLimits config + loader](tickets/02-ratelimits-config-settings-loader.md) — FIXED (#1062): rateLimits schema + clamped loader + getRateLimit in workflow-settings; both tools read it.
- [03 — shared per-provider concurrency limiter](tickets/03-shared-per-provider-concurrency-limiter.md) — FIXED (#1062): globalThis per-provider semaphore wired as outer bound on both subagents + workflow; cross-package sharing proven; no-op until configured.

## Not yet specified

- GLM Pro rate-limit numbers — requests/min, tokens/min, max-concurrent for the "coding plan" Pro tier. Not found in repo or ~/.pi; needed to size N (ticket 01). Also: is the limit strictly RPM, or RPM+TPM? (Determines whether v1 concurrency-cap suffices or a token-bucket is needed sooner.)
- On 429 (rare once capped): current behavior is inconsistent (subagents: single blind retry, no backoff; workflow: provider-limit -> recoverable:false -> pause/checkpoint; core: 2 transport retries w/ backoff). Coherent policy TBD — likely queue-throttle under the cap so 429s rarely fire; bounded backoff retry (retry-after-aware); escalate to pause only on repeated exhaustion. Graduates after the cap lands.
- Token-bucket precision — the concurrency cap is a proxy for RPM; if request-duration variance causes occasional 429s, graduate to an rpm/tpm token-bucket (needs the numbers + a real clock outside the workflow vm). Fog until usage data + numbers.
- Per-tool override — should a call be able to raise its own concurrency above the global cap (e.g. a latency-sensitive workflow)? Probably no (defeats the cap), but unconfirmed.

## Out of scope

- Editing the pi CORE HTTP client / provider transport (`@earendil-works/pi-ai`) — read-only dep; the cap is orchestrator-layer only.
- Capping the singular `subagent` path — it's sequential (concurrency-1), can't burst; safe as-is.
- A 429-resilience/retry layer as the PRIMARY mechanism — the destination is a preventative cap (user chose "global cap," not "retry"). Retry-policy coherence is fog (Not-yet-specified), not a v1 deliverable.
- Other providers (Anthropic/OpenAI) — GLM (zai) is the active provider; generalize later if needed.
