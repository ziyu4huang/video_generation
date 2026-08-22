# 08 — auto-recall injector (before_agent_start, budgeted, off-default)

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open · **Overturns stealth-trim intent (D6/D7)**

## Problem

Knowledge reaches the prompt only if the model voluntarily calls a zk tool — the measured
WRITE side never pays off at USE time. OpenViking's hook-driven auto-recall is the missing
loop; the mechanism (`before_agent_start` per-turn systemPrompt append) is proven in-repo
(ultracode.ts:149, cache-transition 0.98× warm).

## Approach

1. **Probe first (one line):** confirm whether `before_agent_start` fires inside
   spawnSubagent child sessions; the child-guard flag is designed either way (Fog entry,
   map).
2. New `src/inject/auto-recall.ts` + wiring in `extensions/knowledge-card.ts`:
   - Deterministic trigger gate: skip when prompt < N chars / chitchat vocab /
     `retrieveRecords` top score < floor. No LLM intent analysis (D6).
   - Retrieve via `retrieveRecords` (single path), render top-k at L0 tier (ticket 07).
   - Budget: hard cap 350 tok/turn default; per-entry cap 2× average share; overflow demotes
     or drops tail.
   - Subagent-child guard (env/flag the injector checks).
   - Config knob `KC_AUTORECALL` (default off) + `/knowledge-recall` toggle command.
3. Amend `stealth-trim.test.ts` header comment (intent overturned per D7 — letter still
   holds: no tool-schema promptSnippet/guidelines); add the NEW pin: a test asserting the
   injector's per-turn token cap.

## Acceptance

- Unit tests: gate (chitchat/short/low-score skips), budget (cap + 2× rule + demote),
  render, child-guard. Extension-contract test extended.
- Default-off ⇒ merged with zero behavior change; `stealth-trim.test.ts` still green.
- Injection block format is prefix-stable (append-only at systemPrompt tail) for cache
  friendliness.

## Verification

Canonical kcard gates + a scripted session test: two turns, ledger cooldown visible, second
turn injects different/less content (ledger behavior from ticket 09 if landed, else its own
session map).
