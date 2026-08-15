# Wayfinder map: 2026-07-31-let-s-continue-to-improve-base-on-known-upstream

## Destination

A **research-backed, prioritized decision backlog** for `pi-agent-ext-subagent`
and `pi-agent-ext-workflow`. The map ends when the **top ~8–10** highest-impact
candidate improvements — surfaced from three feeds (upstream-pi sync gaps,
known-issue robustness, ecosystem/competitor feature gaps) — each carry a closed
`do / defer / skip` decision with rationale, and the remainder carry a one-line
defer. **Planning only — this map decides, it does not build.** Implementation is
handoff.

## Notes

- **Scope**: `bun-apps/pi-agent-ext-subagent` + `pi-agent-ext-workflow` only.
- **pi baseline**: 0.83.0 installed and confirmed **latest**.
- **Three feeds**: (1) upstream sync — 9 candidates (01); (2) robustness — 5 (02);
  (3) ecosystem — 13 + 8 defer notes (03). Pool = 27.
- **Rubric** (locked in 04): `score = Impact(1–5) × (6 − Effort)(1–5)`, desc. Cut =
  score ≥12 AND Impact ≥4 → **top-10**.
- **⚠️ Ecosystem evidence**: 03's citations are framework-level, URLs unverified
  (live `web_search` unavailable: Zai wrapper bug, Exa rate-limited, no other keys).
  Ecosystem **do**-tickets (12/13/14) carry a "verify before implementation"
  prerequisite. Get a search key into `~/.pi/web-search.json` to clear this.
- **Skills**: `grilling` + `domain-modeling` (HITL, one decision per session).
- Conversational language: 繁體中文; all written artifacts: English.
- **Fact freshness**: charted at behind:0; 04 worked at behind:3 (0 of the 3 touched
  subagent/workflow src, so 01/02/03 cites hold).

## Decisions so far

- [01 — Upstream-pi sync audit](tickets/01-research-upstream-sync-audit.md) — 9 parity gaps; 0.83.0 confirmed latest.
- [02 — Known-issue robustness consolidation](tickets/02-research-known-issues-consolidation.md) — 5 half-known seams; 0 net-new.
- [03 — Ecosystem / competitor scan](tickets/03-research-ecosystem-feature-scan.md) — 13 gaps + 8 defer; ⚠ framework-level citations.
- [04 — Rank & select top-N](tickets/04-grill-rank-and-select-top-n.md) — rubric locked (Impact×(6−Effort)); top-10 = score≥12 & Impact≥4; 17 deferred (one-liners in the ticket). Frontier was {05..14}.
- [09 — Cross-ext singleton handshake](tickets/09-cross-ext-singleton-handshake.md) — **DO**: globalThis-keyed singleton + version-token guard, both singletons (in-flight + persistence); prevent divergence at source rather than detect. Spec + acceptance criteria recorded.
- [06 — Watchdog zero-layer sentinel](tickets/06-watchdog-zero-layer-sentinel.md) — **DO**: double sentinel (`reviewRan` field + ⚠ summary) **escalated to subagent-tool top level**; fires only on ran:true-with-0-layers (not edit-gated/skipped). Spec + acceptance criteria recorded.
- [08 — Watchdog L1 precise delta](tickets/08-watchdog-l1-precise-delta.md) — **DO**: content-level before→after delta (retain per-file hashes in RepoBaseline; L1+L2 lint only content-changed TS/JS). Corrects false premise (delta was NOT pre-computed — `_before` ignored); **Effort revised E2→E3**. Pairs with 06 (visibility) to harden the watchdog gate.

- [Fog trio 12/13/14 closed 2026-08-16](tickets/) — re-open when web-search key exists; 07/10/11 remain frontier.
- 2026-08-16: ticket 07 StringEnum DONE (PR #1467) — Gemini tool-schema routing fixed; ~24 sites/15 files > ticket's 18/5.

## Frontier (open, unblocked, unclaimed)

The route — one do/defer/skip per ticket, HITL:

- [05 — `constrainedSampling`](tickets/05-constrained-sampling-structured-output.md) — upstream · 20
- [07 — `StringEnum` Gemini compat](tickets/07-stringenum-gemini-compat.md) — upstream · 16
- [10 — `model_select` event](tickets/10-model-select-event.md) — upstream · 15
- [11 — `ctx.scopedModels`](tickets/11-scoped-models-honored.md) — upstream · 12
- [12 — Per-agent retry policy](tickets/12-per-agent-retry-policy.md) — eco⚠ · 12
- [13 — Rate-limit token-bucket](tickets/13-rate-limit-token-bucket.md) — eco⚠ · 12
- [14 — Record-replay agent outputs](tickets/14-record-replay-agent-outputs.md) — eco⚠ · 12

## Not yet specified

- **Deferred "own-effort" prizes** (too large for a single disposition ticket;
  harvested at `/wayfind done` as candidate next-efforts): **pack self-eval
  fixtures** (north-star self-improve loop) and **event/OTel observability**
  (highest-leverage, E5; first slice = stream-json mode).
- **Convergence candidates**: run-wide `$` cap + global concurrency governor were
  deferred as a pair with 13 (rate-limit) — if 13 → do, consider folding them into
  one "concurrency & cost control" effort rather than separate tickets.
- **Journal-divergence detector** — deferred; revisits if 14 (record-replay) → do.

## Out of scope

- **Implementation / merged PRs** — decisions, not deliverables.
- **Other extensions** — obsidian, hermes-memory, archify, wayfind, superpowers,
  web-access each own their own efforts. (NB: 09's *symptom* shows in obsidian's
  call site, but the *fix* is subagent's singleton contract — in scope.)
- **Non-improvement maintenance** — version bumps, dep hygiene, CI-only fixes.
- **Re-litigating closed dispositions** — `2026-07-26-known-issues-disposition` and
  the 02 "already closed elsewhere" list stay closed.
