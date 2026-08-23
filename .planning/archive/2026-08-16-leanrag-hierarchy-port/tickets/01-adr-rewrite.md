# Ticket 01 — ADR rewrite (blocked-by: [])

**Status:** done · 2026-08-16
**Resolution:** ADR-hermes-memory-0001 rewritten — ①② deferral superseded in part (user overturn, mitigations (a)–(d)); ③⑤⑥ shipped record and sequencing history preserved; `bun run test:adr` green.


Goal: Rewrite bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md.

Scope: keep ③⑤⑥ shipped record; move ①② from Deferred to Superseded-2026-08-16: user overturn with mitigations (deterministic clustering D5, token-budget gating D6, checkpoints D2, callables injection D4); link seed + this effort.

Acceptance: ADR tells the true current story; bun run test:adr (bun-apps) green.
