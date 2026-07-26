---
type: research
status: closed (2026-07-26) — strategy decided per divergence
---

# 03 — Per-divergence rationale + consolidation strategy

## Resolution — strategy per divergence

| # | divergence | why it diverges | strategy |
|---|-----------|-----------------|----------|
| ① obsidian `lib/subagent.ts` | child_process subprocess | self-contained distill/garden session (curated tools + model override) — isolation load-bearing | → **shared subprocess-wrapper** (04): config-aware + retry/timeout + phantom telemetry |
| ② tool-gate `qa/l2.ts` | spawn("bun",[cli.ts]) subprocess | objective A/B isolation testing (`pi-agent -p`) — isolation load-bearing | → **shared subprocess-wrapper** (04) |
| ③ btw `btw/session.ts` | createAgentSession direct | **persistent tangent thread** (side conversation + thread persistence + model switching) — a different primitive, not a one-shot subagent | → **reclassify out of scope** (tangent-thread ≠ subagent dispatch) |
| ④ core-task `goal/auditor.ts` | createAgentSession direct | **reuses parent's authenticated modelRuntime** (`auditor.ts:165`, extension-registered providers auth) — spawnSubagent re-resolves | → **extend spawnSubagent** with `modelRuntime` opt (07) + consolidate (08) |

### Why ③ btw is out of scope

btw is a **tangent thread** — a persisted, model-switchable side conversation
(`btw/session.ts`: "fully contextless tangent thread", "separate side
conversation. Continue this thread", + thread persistence). It is not a one-shot
subagent task. Forcing it through spawnSubagent would destroy its persistence;
extending the runner with persistent-session mode would over-engineer it for one
edge use-case. It is a different primitive. (Its own robustness — model-config,
retry — is a separate concern, not "unify subagent dispatch.")

### Why ④ core-task extends the runner (not reclassified)

The auditor reuses the parent's `modelRuntime` for in-context goal auditing using
the SAME authenticated runtime. This is a **broadly-useful capability** (auth/
context sharing), not an edge use-case — a `modelRuntime` opt on spawnSubagent is
small + general. The auditor IS a dispatched subagent (it runs a full audit
prompt in a child session); it just needs to share the parent's runtime. So:
extend the runner + consolidate.

## Graduated build tickets

- [04 — shared subprocess-wrapper](tickets/04-shared-subprocess-wrapper.md) (keystone; ① ② vehicle)
- [05 — obsidian → shared wrapper](tickets/05-obsidian-route-through-shared-wrapper.md) (blocked by 04)
- [06 — tool-gate → shared wrapper](tickets/06-tool-gate-route-through-shared-wrapper.md) (blocked by 04)
- [07 — spawnSubagent `modelRuntime` opt](tickets/07-spawnsubagent-modelruntime-opt.md)
- [08 — core-task → spawnSubagent](tickets/08-core-task-consolidate-onto-spawnsubagent.md) (blocked by 07)
- [09 — skills alignment audit](tickets/09-skills-alignment-audit.md) (low priority)

## blocked by

01 (closed), 02 (closed) — both resolved.
