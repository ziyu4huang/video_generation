# 10 — injection probes + default flip (measure, then decide)

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` (+ scripts) · **Status:** closed 2026-08-29 · **RISKY: token-budget critical**

## Resolution (2026-08-29 — flip gate FAILED; default stays OFF, D11)

Probe `bun-apps/s2-agent-ext-knowledge-card/scripts/cache-probe-inject.mjs`
(ultracode cache-probe pattern ported; committed). Measured on this machine,
real vault `pi-agent-vault` via `OB_VAULT_PATH` (827 cards), LM Studio
`prism-ml/bonsai-27b` chat + `text-embedding-bge-m3` embed; receipt
`output/injection-probe/receipt-2026-08-28T23-27-32-435Z.json`:

- **(a) tokens/turn**: p50 240 / p95 282 ≤ 350 cap ✅ — but injection rate
  **2/20 scripted turns (10%)**: `scoreFloor: 2` suppresses near-perfect
  retrievals (a hand-written lora/argparse question retrieves the exact right
  cards at sharedTags=1). floor=1 measures 5/14 injected, same p95.
- **(b) cache-transition**: **1.156× warm > 1.05× target** ❌ (single-entry KV;
  block rides the systemPrompt tail so absolute cost is +46 ms/turn at 282 tok
  — small, but the ticket's own gate says no-flip).
- **(c) chitchat skip**: 20/20 = **100%** ≥ 80% ✅.

**Decision (D11 in spec):** `KC_AUTORECALL` stays opt-in; no skills update
(injection remains off by default). Re-probe required after any of: floor
recalibration, CJK-aware minPromptChars (40 CHARS gates out typical zh
questions, ~20 chars — 2/10 substantive probes failed on length alone), or
t16's end-task delta.

**Three operational findings (map Context):**
1. Cold-start silent no-op — the first probe run injected 0/20: the first
   semantic call pays the bge-m3 cold load and exceeds the injector's 3 s
   timeout (warm re-run, same script: 2/20). A flipped default would no-op
   silently for the first turns of a session after server idle.
2. Vault-resolution trap — `resolveVault` from a repo cwd resolves to the
   personal-config vault (`study-news`), NOT the kcard knowledge vault; its
   generic page cards scored sharedTags 0 and the floor correctly suppressed
   everything (defense worked), but the flip measurement almost ran against
   the wrong corpus.
3. Cooldown-silent turns count as non-injected in the probe denominator —
   re-probes after recalibration should report the gated/cooled split (the
   receipt's perTurn already does).

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
