> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-26-explorer-other-pi-agent-ext-in-bun-apps-see-any-

## Destination

Every subagent dispatch in the repo flows through ONE unified, strong path
(`spawnSubagent` / `WorkflowAgent`). The **4 divergent runners** found in the
audit — **obsidian** + **tool-gate** (child-process subprocess model) and **btw**
+ **core-task** (direct `createAgentSession`, bypassing the runner) — are either
consolidated onto the unified path OR consciously retained with a documented
rationale. Every dispatch inherits the four "stronger" guarantees: runner-path
unity, model-resolution via config (no hardcodes), error/retry/timeout, and
telemetry (in-flight + run-persistence visibility to `/subagents`). The map ends
when the consolidation approach for each divergence is decided + the unified
contract is locked.

## Notes

- **Domain**: pi-agent extension ecosystem (`bun-apps/pi-agent-ext-*`). The
  unified runner + its guarantees live in `pi-agent-ext-subagent`
  (`spawnSubagent` / `WorkflowAgent` — already strong: `timeoutMs` +
  `retryOnTransient` default-true + in-flight registry + run-persistence +
  model-config via `tiers`/`capabilities`).
- **Skills to consult**: `grilling` + `domain-modeling` (ticket 02 contract);
  `systematic-debugging` if a consolidation breaks a consumer.
- **Standing preference**: prefer consolidating onto the existing unified runner
  over building new abstraction. No hardcoded model ids (the no-hardcode
  principle from the model-config work applies to every divergent runner too).
- **Terminal**: macOS Terminal.app.
- Conversational language: 繁體中文; all written artifacts: English.

## Decisions so far

- [01 — Audit: every subagent-triggering surface](tickets/01-audit-subagent-trigger-surfaces.md) — **4 divergences found** (obsidian + tool-gate subprocess; btw + core-task direct `createAgentSession`) across 2 models; 5 unified consumers; skill drivers cataloged (superpowers SDD biggest). archify/deploy/wayfind/movie-binary spawns ruled out (not subagent dispatch).
- [02 — Define the "strong unified dispatch" contract](tickets/02-define-strong-unified-dispatch-contract.md) — **contract locked**: unified = 4 guarantees (runner-path via `spawnSubagent` OR a shared subprocess-wrapper; config-only models; retry/timeout default-on; telemetry registered + visible). Mechanism secondary to guarantees. `btw`/`core-task` → in-process; `obsidian`/`tool-gate` → shared subprocess-wrapper.
- [03 — Per-divergence rationale + consolidation strategy](tickets/03-per-divergence-rationale-and-consolidation-strategy.md) — **strategy decided** (research revised 02's assumption): ① obsidian + ② tool-gate → **shared subprocess-wrapper** (04; isolation load-bearing); ③ btw → **reclassified out of scope** (persistent tangent thread ≠ one-shot subagent); ④ core-task → **extend spawnSubagent** with `modelRuntime` opt (07) + consolidate (08; reuses parent runtime). Graduated build tickets 04–09. _(Post-03: ② tool-gate later reclassified out of scope by 06 — its raw A/B semantics are incompatible with the structured wrapper; see 06.)_

## Build phase (graduated from 03)

The research/grilling fog is cleared. Remaining work is **execution** (task tickets):

- [04 — shared subprocess-wrapper](tickets/04-shared-subprocess-wrapper.md) — **unblocked keystone** (the ① ② vehicle).
- [05 — obsidian → shared wrapper](tickets/05-obsidian-route-through-shared-wrapper.md) — blocked by 04.
- [06 — tool-gate → shared wrapper](tickets/06-tool-gate-route-through-shared-wrapper.md) — **RECLASSIFIED OUT OF SCOPE** (post-03 evidence): l2.ts is a raw prompt-mode A/B harness needing env-override arming + raw stdout/stderr grep — both invariants the structured-subagent wrapper breaks (no env passthrough; NDJSON-only output). Mirrors btw. §3 retry would skew A/B; l2.ts is explicitly experimental/uncalibrated.
- [07 — spawnSubagent `modelRuntime` opt](tickets/07-spawnsubagent-modelruntime-opt.md) — **unblocked** (independent of 04; small, broadly-useful).
- [08 — core-task → spawnSubagent](tickets/08-core-task-consolidate-onto-spawnsubagent.md) — **RECLASSIFIED OUT OF SCOPE** (post-03 evidence): the auditor is a *supervised session* (event-stream subscription for must-call-read-tool + regression_shield; 10-min inactivity stall watchdog ≠ total timeout; custom no-extension infra; own disapproval-retry). spawnSubagent is one-shot, doesn't expose the session/event stream. Auth-sharing goal already met via direct `createAgentSession({ modelRuntime })` (~L165). Mirrors btw/06.
- [09 — skills alignment audit](tickets/09-skills-alignment-audit.md) — **CLOSED: no drift**. No skill instructs a divergent dispatch mechanism (the 2 `child_process` refs are utility scripts, not dispatch). SDD skills speak abstractly (can't point wrong); the canonical `pi-tools.md` reference was already aligned with the unified `subagent`/`workflow` surface. One completeness fix: added a "Process isolation (subprocess runner)" paragraph documenting `spawnSubagentSubprocess` (04) — the reference previously covered only the in-process runner.

**DESTINATION REACHED — all 9 tickets closed.** Build phase: 04 (wrapper) + 05 (obsidian → wrapper) + 07 (modelRuntime opt) landed; 06 (tool-gate) + 08 (core-task) reclassified out-of-scope (same pattern as btw); 09 confirmed skills already aligned (one completeness fix). **Scope conclusion**: the unified runner serves **fire-and-forget subagents** (obsidian, knowledge-card, file2md, workflow, memory-to-vault); supervised/specialized sessions (btw, tool-gate A/B, core-task auditor) are correctly excluded — each needs semantics the one-shot runner can't provide without destroying load-bearing invariants.

## Out of scope

- **Binary-invocation spawns** — ffmpeg / mlx / archify's vendored renderer / deploy command-runner. These spawn binaries, not subagents. (archify `lib/run.ts` confirmed: runs its own diagram-renderer CLI, not pi.)
- **btw tangent thread** — `btw/session.ts` is a persisted, model-switchable side conversation, not a one-shot subagent. Reclassified out of scope by 03 (forcing it through spawnSubagent would destroy its persistence; the runner is one-shot by design). Its own robustness is a separate concern.
- **The interactive picker** — separate effort, just shipped (PR #848–#870).
