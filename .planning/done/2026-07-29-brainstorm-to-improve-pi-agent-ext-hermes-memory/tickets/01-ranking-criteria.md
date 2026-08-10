# 01 — Ranking criteria for the improvement spec

type: grilling
blocked by: —
claimed: wayfind (claude, 2026-07-29)

## Question

The destination is a **prioritized** spec. On what axes do we rank candidate
improvements, and with what weighting? Every verdict ticket (06–08) and the spec
assembly (09) rank against the answer to this ticket, so it must settle first.

Candidate axes to weight (propose, confirm, or replace):

1. **Retrieval-quality / capability gain** — how much does it actually improve
   what the agent recalls?
2. **Pi-architecture fit** — portability onto hermes's MD+SQLite spine under
   no-CUDA / MLX-only / Apple-Silicon.
3. **Implementation effort** — rough size (S/M/L) to land in hermes.
4. **Token / cost impact** — effect on first-turn tokens (hermes is policy-only
   to stay cheap) and on running cost.
5. **Fit with hermes's existing strengths** — policy-only mode, subagent-based
   learning loop, secret scanning. Does it amplify or fight them?

## Recommended answer

Weight **(1) retrieval-quality gain** and **(2) Pi-architecture fit** highest as
*scoring* axes; treat **(3) effort** and **(4) token-cost** as *gates/filters*
(disqualify or defer anything that's L-effort or blows the token budget, rather
than letting a high-score-but-huge item dominate); use **(5) fit-with-strengths**
as the tiebreaker. Net effect: favor high-gain, cheap-to-port, token-neutral
improvements that extend what hermes already does well.

Confirm, adjust weights, or reframe — then this ticket closes and unblocks the
verdicts.

## Resolution

_Closed (grilling) — 2026-07-29. Accepted the recommended model._

**Ranking model for the improvement spec** (06/07/08 verdicts + 09 spec rank against this):

- **Scoring axes (weighted blend):**
  1. **Retrieval-quality / capability gain** — how much it actually improves what the agent recalls.
  2. **Pi-architecture fit** — portability onto hermes's MD-source-of-truth + SQLite spine under no-CUDA / MLX-only / Apple-Silicon.
- **Hard gates (filter, don't score-rank):**
  3. **Implementation effort** — L-sized items → **defer** (not reject).
  4. **Token / cost impact** — exceeds the (to-be-pinned) ceiling → **defer**. _Concrete thresholds decided within the verdict tickets; the token-cost ceiling is pinned in 08._
- **Tiebreaker:**
  5. **Fit with hermes's existing strengths** — amplifies (vs fights) policy-only mode, the subagent-based learning loop, and secret scanning.

**Net effect:** favor high-gain, cheap-to-port, token-neutral improvements that extend what hermes already does well. Gates **defer** rather than kill — a deferred item returns as a follow-up, not a rejection. This unblocks 06, 07, 08.
