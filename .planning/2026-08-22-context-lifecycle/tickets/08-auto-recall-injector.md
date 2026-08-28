# 08 — auto-recall injector (before_agent_start, budgeted, off-default)

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-28 · **Overturns stealth-trim intent (D6/D7)**
- **claimed:** 2026-08-28 claude-code-glm @ video_generation__memory (wayfind knowledge-pipeline-next session)

## Resolution (2026-08-28)

Shipped default-off on branch `wayfind/knowledge-pipeline-next` (kcard 711 / core-runtime
495 tests green, typecheck green both packages):

- **Probe (see Problem section insert):** before_agent_start DOES fire in children on both
  spawnSubagent paths → the child-guard is load-bearing and rides a NEW
  `S2_AGENT_SUBAGENT` env marker: core-runtime sets it around each in-process attempt
  (restore in `finally`, prior value preserved) and passes it in the subprocess spawn env;
  kcard's injector only reads it (`isSubagentChild()`). Race-free because the parent's turn
  is blocked on the tool call while children run. Recorded as map **D9**.
- **`src/inject/auto-recall.ts`:** deterministic gate (minPromptChars 40, anchored
  chitchat regex, query→tags mirror of knowledge_query); single retrieval path
  (`retrieveRecords`, tier "abstract", bodyMatch+slugDom+semantic, 3s hard timeout that
  injects nothing on miss); score floor on the top card's `sharedTags` (the ranking score
  pre-boost, floor 2); budget = 350 tok/turn cap + per-entry 2×-average-share rule +
  tail-drop (L0 is the floor tier, so demote degenerates to drop — never slices);
  prefix-stable `<knowledge-recall>` block (fixed open/hint/close, ranked bullets).
- **Wiring (`extensions/knowledge-card.ts`):** `before_agent_start` handler (never throws,
  appends at systemPrompt tail), `/knowledge-recall` command (status | on | off,
  per-session toggle), `KC_AUTORECALL=1` arms new sessions. Default OFF → zero behavior
  change merged.
- **Tests:** 15 hermetic unit pins (`__tests__/auto-recall.test.ts` — gate/floor/budget/
  render/child-guard/degradation); extension-contract pin (hook registered, default-off
  returns undefined, no env leak); stealth-trim header amended (D7: letter holds — no
  promptSnippet/guidelines — intent overturned) with the token-cap pin cross-referenced;
  3 core-runtime marker pins (live-during-run, prior-value restore, restore-on-failure).
- **Known limits (deliberate):** per-session state is in-memory (a restart re-reads
  KC_AUTORECALL) — t10 decides durability with the flip; the injector feeds NO ledger yet
  (usageLog:false) — that is exactly ticket 09's RecallLedger.

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
concurrently, so a plain env toggle is racy; the guard needs a non-env seam
(session-level flag via the `session:` override on `WorkflowAgentOptions`, or
equivalent). Double-inject risk is REAL; the child-guard is load-bearing.

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
