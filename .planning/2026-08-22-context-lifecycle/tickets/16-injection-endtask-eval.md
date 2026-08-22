# 16 — end-task eval: does injection actually help?

- **Phase:** P4 · **Package:** `s2-agent-ext-knowledge-card` (+ scripts) · **Status:** open · **cap ≤ 1 h runtime**

## Problem

Retrieval hit@k measures retrieval, not task success (the Fog entry says this is unknown by
construction). Before the injection default is considered FINAL, measure answer accuracy
with auto-recall on vs off on questions whose answers live only in cards.

## Approach

1. Build a 20-question probe set over the real vault (questions answerable ONLY from
   specific cards; mix zh-TW phrasing; include 5 chitchat negatives that must NOT trigger).
2. Script: headless `./s2-agent.sh -p "<question>"` per question, two arms
   (`KC_AUTORECALL=1` vs `=0`), local model per central model-tiers; grade answers
   deterministically where possible (keyword/id presence) + record tokens/turn per arm.
3. Success criterion: accuracy delta ≥ 0 (injection must at least not hurt) and tokens/turn
   within the 350-tok budget on average; a negative delta rolls the default back to off and
   records why (methodology: promotion needs a measured win).
4. Receipt + go/no-go note in map Frontier.

## Approach note

Serialize the runs (concurrent agents driving the same LM Studio model truncate each other —
known trap); keep the whole run ≤ 1 h (cap rule).

## Acceptance

- Probe set + grader committed (`scripts/injection-endtask.mjs` + fixture questions);
  receipts recorded; go/no-go decision in map.

## Verification

One full run receipt (accuracy both arms, tokens/turn, duration); decision recorded.
