---
type: grilling
blocked by: [01, 02, 03]
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (rubric locked; 27 scored; top-10 → tickets 05–14; 17 deferred)
---

# 04 — Rank candidates & select top-N for disposition

## Question

Merge 01/02/03 candidate lists (27), score impact×effort, select top ~8–10;
defer the rest. Lock the rubric.

## Resolution (grilled 2026-07-31, branch behind:3 but 0 of those touch subagent/workflow src)

**Decisions locked (3 grilled forks):**

1. **Ecosystem evidence** (Q1): score the 13 ecosystem candidates on framework-level
   evidence; each selected ecosystem **do**-ticket carries a "verify before
   implementation" prerequisite (re-run the 03 query list with working search keys).
   Does NOT block scoring.
2. **Rubric** (Q2): `score = Impact(1–5) × (6 − Effort)(1–5)`, range 1–25, desc.
   Impact blends user-breadth / correctness-robustness / upstream-parity; Effort =
   code-surface × test/risk burden.
3. **Cut** (Q3): **Top-10 = score ≥12 AND Impact ≥4** (clean tiebreak between
   rank 10 @ I4 and rank 11 @ I3, both score 12). 4 upstream / 3 robustness /
   3 ecosystem.

**Top-10 (→ graduate as grilling tickets 05–14, each do/defer/skip):**

| # | ticket | candidate | axis | I | E | score |
|---|---|---|---|---|---|---|
| 1 | 05 | `constrainedSampling` on structured_output | upstream | 4 | 1 | 20 |
| 2 | 06 | Watchdog zero-layer-ran → hard ⚠ sentinel | robust | 4 | 1 | 20 |
| 3 | 07 | `StringEnum` (Gemini compat, 18 sites) | upstream | 4 | 2 | 16 |
| 4 | 08 | Watchdog L1 precise before→after delta | robust | 4 | 2 | 16 |
| 5 | 09 | Cross-ext singleton identity handshake | robust | 5 | 3 | 15 |
| 6 | 10 | `model_select` event subscription | upstream | 3 | 1 | 15 |
| 7 | 11 | `ctx.scopedModels` honored | upstream | 4 | 3 | 12 |
| 8 | 12 | Per-agent retry policy + backoff + non-retryable | eco⚠ | 4 | 3 | 12 |
| 9 | 13 | Rate-limit token-bucket concurrency scheduler | eco⚠ | 4 | 3 | 12 |
| 10 | 14 | Record-replay (pin agent outputs) | eco⚠ | 4 | 3 | 12 |

**Deferred (17) — one-liner each (full list, not re-ticketed):**

- Abort/timeout → controller-state signal (drop substring match) — *defer*:
  future-proofing against SDK drift not yet biting; revisit when SDK surfaces abort
  as a non-`Error`.
- Crash-lease TTL/reclaim — *defer*: small real win but hard-kill resume is rare;
  bundle into a later robustness pass.
- `getCommands` sourceInfo ownership — *defer*: edge-case (same-named command
  masquerade); cheap if ever needed.
- **Pack self-eval fixtures ⭐north-star (I5)** — *defer to its own effort*: too
  large for one disposition ticket; deserves a dedicated wayfind when the
  self-improve loop is prioritized. *(prize)*
- Journal-divergence detector — *defer*: advanced determinism; revisit if 14
  (record-replay) → do.
- Cross-run response cache — *defer*: opt-in infra; revisit when an eval matrix
  creates rerun pressure.
- `systemPromptOptions` read in `before_agent_start` — *defer*: minor; fold in if
  10's area is touched.
- `appendEntry`/renderer for TUI-only cards — *defer*: real token saving but a
  10-customType rework; bundle into a TUI-overhaul effort.
- `registerShortcut`/`Flag` for effort/workflow modes — *defer*: DX nicety; pick
  up opportunistically.
- `/subagents` completed-list time-label refresh — *defer*: cosmetic (redesign
  spec already logged it).
- Run-wide $ cap + cost ledger — *defer*: pair with 13 (rate-limit) as one
  combined cost/concurrency-control effort.
- Process-global concurrency governor — *defer*: cross-cutting; bundle with 13.
- `registerMessageRenderer` (10 customTypes) — *defer*: cosmetic; folds into the
  appendEntry TUI effort.
- Pack registry/hub — *defer*: ecosystem growth, low urgency; separate effort.
- **Event/OTel observability (I5, highest-leverage)** — *defer to its own effort*:
  E5 too large for one ticket; first slice = stream-json mode, deserves a dedicated
  wayfind. *(prize)*
- Skill/MCP surfacing in subagents — *defer*: contingent on pi landing a stable
  skill/MCP tool factory; revisit on pi API change.
- Composite/nested workflow packs — *defer*: large decomposition feature; own effort.

**Map-close gate**: the map closes when all of 05–14 carry a closed do/defer/skip.
Until then the **frontier = {05..14}** (10 open, unblocked, unclaimed grilling
tickets). The two ⭐prizes (pack-eval, observability) are harvested as deferred
next-efforts at `/wayfind done`.
