# 10 — injection probes + default flip (measure, then decide)

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` (+ scripts) · **Status:** open · **RISKY: token-budget critical**

## Problem

Always-on injection is a bet on tokens vs task win. Flipping the default without numbers
violates the effort's own methodology (every promotion needs a measured win — the IDF-gate
lesson). OpenViking's assembler numbers (34–91% fewer input tokens) came from a different
stack; ours must be measured.

## Approach

1. Port the ultracode cache-probe pattern → `scripts/cache-probe-inject.mjs`: measure on
   local LM Studio (a) tokens-injected/turn p50/p95 across a scripted 20-turn session,
   (b) cache-transition cost injected-vs-clean turn (target ≤ 1.05× warm),
   (c) no_relevant-skip rate on a chitchat probe set (target ≥ 80%).
2. Record D6/D7 as settled decisions in map (injection live, default flipped) ONLY if
   metrics pass; otherwise keep default-off and record why.
3. If metrics pass: flip `KC_AUTORECALL` default on; update skills
   (`using-knowledge-cards` SKILL.md) to describe auto-recall + how to disable.
4. Numbers land in map Context (measured date, machine).

## Acceptance

- Probe receipts committed (scripts + numbers in map); default state decided with evidence.
- Post-flip: full kcard gates green; no schema-cost regression (injector adds none — D7).

## Verification

Canonical gates + re-run probes after flip; spot-check one real session via
`./s2-agent.sh -p` (headless) with injection visible in a debug env (`KC_AUTORECALL_DEBUG`).
