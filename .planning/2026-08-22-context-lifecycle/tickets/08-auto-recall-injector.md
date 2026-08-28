# 08 — auto-recall injector (before_agent_start, budgeted, off-default)

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-28 · **Overturns stealth-trim intent (D6/D7)**
- **claimed:** 2026-08-28 claude-code-glm @ video_generation__memory (wayfind knowledge-pipeline-next session)

## Resolution (2026-08-28)

Shipped default-off on branch `wayfind/knowledge-pipeline-next` (kcard tests + typecheck
green; review round 2's BLOCKING finding fixed, kcard-only PR):

- **Probe (see Problem section):** before_agent_start DOES fire in children on both
  spawnSubagent paths → the child-guard is load-bearing. Guard = per-session
  `ctx.sessionManager.getSessionFile()` falsy ⇒ in-memory child ⇒ skip (map **D9**,
  re-decided; the first env-marker design was refuted by review round 2 — background
  dispatch races, see Problem). Zero core-runtime surface in the final design.
- **`src/inject/auto-recall.ts`:** deterministic gate (minPromptChars 40, anchored
  chitchat regex, query→tags mirror of knowledge_query); single retrieval path
  (`retrieveRecords`, tier "abstract", bodyMatch+slugDom+semantic, 3s hard timeout that
  injects nothing on miss); score floor on the top card's `sharedTags` (the ranking score
  pre-boost, floor 2); budget = 350 tok/turn cap + per-entry 2×-average-share rule +
  ranked-walk drop-what-doesn't-fit-keep-scanning (L0 is the floor tier, so demote
  degenerates to drop — never slices); prefix-stable `<knowledge-recall>` block (fixed
  open/hint/close, ranked bullets; ~25 tok chrome rides on top of the cap).
- **Wiring (`extensions/knowledge-card.ts`):** `before_agent_start` handler (never
  throws; vault resolution inside the same 3s bound; appends at systemPrompt tail),
  `/knowledge-recall` command (status | on | off, per-session toggle),
  `KC_AUTORECALL=1` arms new sessions (captured at factory time). Default OFF → zero
  behavior change merged.
- **Tests:** hermetic unit pins (`__tests__/auto-recall.test.ts` — gate/floor/budget/
  render/child-guard/degradation); extension-contract pins (hook registered; default-off
  returns undefined; ARMED hook skips an in-memory child ctx and APPENDS
  `BASE\n\n<knowledge-recall>…</knowledge-recall>` for a persisted parent ctx over a
  real tmp vault — the review-flagged wiring gap, closed); stealth-trim header amended
  (D7: letter holds — no promptSnippet/guidelines — intent overturned) with the
  token-cap pin cross-referenced.
- **Known limits (deliberate):** per-session state is in-memory (a restart re-reads
  KC_AUTORECALL) — t10 decides durability with the flip; the injector feeds NO ledger
  yet (usageLog:false) — that is exactly ticket 09's RecallLedger; the ticket's
  "scripted two-turn session test" is deferred INTO t09's acceptance (it tests the
  ledger's cooldown, which does not exist yet).

## Problem

**Probe result (2026-08-28, recorded before build):** YES — `before_agent_start`
fires inside spawnSubagent child sessions, BOTH paths. In-process:
`spawnSubagent` → `createAgentSession` (`s2-agent-core-runtime/src/agent.ts:430`)
is a full AgentSession whose `prompt()` emits the hook
(`pi-coding-agent/dist/core/agent-session.js:884`), and child sessions "start
with a fresh extension load from disk" (`agent.ts:49-50`) so the kcard handler
runs in every child. Subprocess: `pi -p --mode json` headless is also a full
AgentSession. No existing env/flag marks a child (`PI_SELF_ENTRY_PREFIX` is
unrelated) — and in-process children share `process.env` while running
concurrently, so a plain env toggle is racy; the guard needs a non-env seam.
Double-inject risk is REAL; the child-guard is load-bearing.

**Review round 2 (same day) refuted the env-marker design and forced the
re-decision:** `fork:true` background dispatch returns the tool call immediately
and runs `spawnSubagent` DETACHED in the parent's process while the parent's
turn loop continues — so (a) the parent's own hook would false-positive on the
marker for the whole background window (recall silently off), and (b)
overlapping child attempts corrupt each other's restore (sticky marker =
recall permanently off while `/knowledge-recall` still reports ARMED). The
shipped guard is PER-SESSION instead: every child path runs on an in-memory
session, so the hook reads its own `ctx.sessionManager.getSessionFile()` and
skips on falsy — no core-runtime surface, immune to background dispatch and
overlap by construction. See map D9 for the re-decision and its known limits.

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
