---
type: task
status: open
---

# 05 — Tool/CLI surface wiring + effort close-out

## Question
Given the gate outcome, what is the minimal durable surface for the resource tier, and is the effort honestly closed?

## What to build
Surface wiring per the ticket-04 gate: if PASSED, extend `zk_fs` (op: ls/tree/stat over resource trees rendering L0 by default with tier promote — parity D32/D35 shape) and/or a `resource_query` action on the existing query lane, with schema-cost discipline; if FAILED/deferred, the CLI surface stays and the map records why. Then close-out: cross-effort back-links updated (parity + production-hardening maps get the resource-tier completion note), glossary additions to `bun-apps/s2-agent-ext-knowledge-card/CONTEXT.md` (resource, L0/L1/L2, abstract, overview, trajectory), ADR only if a decision proves hard-to-reverse + surprising (candidate: D3 sidecar stance), memory entry, successor next-goal.

## Acceptance
- [ ] Surface decision recorded with gate numbers cited; if `zk_fs` extended, one gate-family probe set added and schema-cost canary re-run
- [ ] CONTEXT.md glossary terms added (one `**Term**:` + `_Avoid_:` each); CONTEXT-MAP.md unchanged (no new context)
- [ ] Both predecessor maps' Cross-effort links updated; effort map status → complete; tickets closed with Resolutions
- [ ] Successor next-goal written (validator-passing, LATEST re-pointed) — includes the cross-package OpenViking naming/feature alignment item (user 2026-08-25) as a ranked goal
- [ ] Canonical `bun run test` green; reviewer pass (or disclosed inline fallback)
