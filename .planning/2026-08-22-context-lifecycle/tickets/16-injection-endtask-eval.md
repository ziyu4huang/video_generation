# 16 — end-task eval: does injection actually help?

- **Phase:** P4 · **Package:** `s2-agent-ext-knowledge-card` (+ scripts) · **Status:** closed 2026-08-29 · **cap ≤ 1 h runtime**

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

## Resolution (2026-08-29, this machine)

**GO on payoff — injection moves end-task accuracy: unarmed 4/20 (20%) → armed floor=0
12/20 (60%), Δ+40pct; ticket gate (armed ≥ unarmed) PASS.** Full battery
`scripts/injection-endtask.mjs` (20 zh-heavy vault-grounded questions + 5 chitchat
negatives, deterministic grader, serialized, `--thinking off --tools read`, bonsai-27b,
43 min ≤ 1 h cap), receipt `output/injection-endtask/receipt-2026-08-29T01-57-14-101Z.json`:
- Calibration (deterministic, no LLM): floor=2 → 1/20 injected; floor=1 → 1/20; **floor=0 →
  20/20 injected, 20/20 with the TARGET card in the block**, block tokens median 323 / max
  377 (≤350 cap + coarse-estimate noise); chitchat gate 0/5 tripped (CJK-weighted length).
- Arms: off 4/20 (20%) · floor2 2/20 (10%, ≈ no-op injector as calibration predicts, within
  timeout noise) · **floor0 12/20 (60%)**. Per-turn injection evidence `kept=3 tok=338`
  (manual armed child under final conditions; the run's own inj column read 0 from a
  receipt-parser regex bug — error group missing its optional `?` — fixed in-commit, does
  not touch accuracy grading).
- **Calibration decision (D12)**: the CJK-weighted length gate SHIPS (code change; t10's
  2/10 zh length-misses fixed); `scoreFloor` stays 2 by default — floor=0 was measured via
  `KC_AUTORECALL_FLOOR=0` env only, because floor=0's precision on OFF-TOPIC substantive
  prompts is unmeasured (the battery's negatives are chitchat-only). New structural finding:
  `scoreFloor` is a lexical-only floor (query tags are ASCII-derived, `sharedTags` can never
  clear it for zh prompts) — a CJK-aware minPromptChars alone does NOT un-gate zh.
- **Three operational findings (receipts + map Context)**: (1) hermes auto-converge at
  session_shutdown touches vault card mtimes → the semantic cache's name+mtime fingerprint
  invalidates EVERY session → full 828-card re-embed burst (measured 53 s) → the injector's
  3 s bound is unreachable in any real post-converge session (battery ran with
  `OB_HERMES_AUTOCONVERGE=0`; the fix is follow-up work — flip stays gated on it);
  (2) LM Studio :1234 wedges intermittently under load (embeddings >10 s while /v1/models
  answers; recovered standalone) — armed arms silently no-op during wedges, now surfaced by
  `trace.error` in the debug line; (3) `SEMANTIC_EMBED_BASE` is honored by the standalone
  script but measured NOT honored inside the extension-loaded s2-agent child (battery arms
  ride :1234 regardless of env).
- **Flip decision: default stays OFF (D11 unchanged).** The end-task payoff question is
  ANSWERED (yes, +40pct under floor=0), but flipping requires: the converge/cache fix (1),
  a floor=0 precision probe on off-topic substantive prompts, and D11's cache-gate re-probe
  (floor=0 blocks are bigger: median 323 vs t10's 282 p95 — the 1.156× transition ratio
  will not have improved).
