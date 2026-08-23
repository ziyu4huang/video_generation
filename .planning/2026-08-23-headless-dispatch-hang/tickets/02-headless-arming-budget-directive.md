# Ticket 02 — headless workflows arming + budget directive (B2)

Status: done (2026-08-23, PR pending)

## Problem

`bun-apps/s2-agent-ext-ultracode/src/workflow-editor.ts:497` — the input hook
that arms workflows mode (keyword `workflow`/`ultracode`) and parses budget
directives (`+500k`) returns early unless `event.source === "interactive"`.
The live-smoke reading (2026-08-23 afternoon) was that headless `-p` messages
carry a different source, so:

- workflows mode never arms headless (the model may still call `run_workflow`
  as an ordinary tool — measured live),
- a `+500k` directive in a headless message is silently ignored.

Measured 2026-08-23: message `ultracode +500k Run this workflow script …` via
`-p` produced run `mt5msv81-dq40xz` (34,019 tokens, completed) whose persisted
record at
`~/.pi/workflows/projects/video_generation__subagent-7b9ba1837451/runs/mt5msv81-dq40xz.json`
has NO `tokenBudget` / `tokenBudgetSource` field, and the model called
`run_workflow` as a tool rather than a forced-workflow turn.

## Decision (resolved 2026-08-23 evening)

**Neither (a) nor (b) as framed — the premise was wrong; the resolution is
"verify + pin": no guard change, spec rows corrected in the same PR.**

- The source guard does NOT discriminate print mode. Upstream SDK 0.84.2:
  print mode calls `session.prompt(initialMessage, { images })` with NO
  `source` (`dist/modes/print-mode.js`), and `AgentSession.prompt` emits the
  input event with `options?.source ?? "interactive"`
  (`dist/core/agent-session.js`) — headless `-p` input events carry
  `"interactive"`, so the guard passes and the arming transform runs headless.
- The measured negative's ACTUAL cause: `keywordTriggerEnabled: false` in this
  machine's global `~/.pi/workflows/settings.json` — the keyword trigger is off
  EVERYWHERE (interactive runs included), so `ultracode …` arms nowhere on this
  machine regardless of mode. The smoke conflated a per-machine settings state
  with a headless gap.

## Evidence (A/B live probe, 2026-08-23 evening, scratch project /tmp/b2-probe, local lm-studio model)

Probe gotcha worth keeping: the extension keys project settings by the
RESOLVED cwd — `/private/tmp/b2-probe` on macOS, not `/tmp/b2-probe`. The
first corrected-key run is the valid one.

- **Trigger OFF (machine's global state, matches the original smoke):** run
  `mt5pwx3c-30sjnp` — transcript user message is the RAW text (no
  forced-workflow preamble), `exec: { tokenBudget: 500000,
  tokenBudgetSource: "model" }` — the model improvised `tokenBudget: 500000`
  in its `run_workflow` call from the raw `+500k` text; the directive holder
  was never set.
- **Trigger ON (per-project override `keywordTriggerEnabled: true`):** run
  `mt5q0urv-9hdejl` — transcript user message carries the
  `[workflows mode is ON for this message]` forced-workflow preamble (the
  transform ran headless), `exec: { tokenBudget: 500000,
  tokenBudgetSource: "merged" }` — the directive holder was consumed at run
  entry and merged with the model-passed budget.
- Deterministic pin: `bun-apps/s2-agent-ext-ultracode/tests/headless-arming-parity.test.ts`
  — drives a real AgentSession over the faux transport with the exact
  print-mode call shape (`prompt(text)` with no options), asserts the input
  event delivers `source: "interactive"`, then feeds that observed source into
  the real workflow-editor handler and asserts transform + `consumeBudgetDirective()
  === 500_000`. If an SDK upgrade changes the default source (re-opening a real
  headless gap), this test fails.
- Two earlier probe attempts hit the B1 hang shape and were bounded by the
  print-idle watchdog (exit 2, `Active event-loop resources: []`) — one during
  a heavy contention window (concurrent merge-pr + local-ci + multi-worktree
  tests), one with a too-tight 120s deadline against the local 27B model
  (print mode writes stdout only at completion). Consistent with ticket 01's
  phenomenology; no new signal.

## Done when

- [x] Option chosen and recorded (spec §2 row + this ticket).
- [x] Headless parity verified + pinned: a headless `-p` message with
      `ultracode +500k` arms (measured live, run `mt5q0urv-9hdejl`), the run
      record persists `tokenBudget`/`tokenBudgetSource`
      (`"merged"` — directive folded with the model-passed budget), and
      `tests/headless-arming-parity.test.ts` pins the chain deterministically.
      No code change was required — parity already holds; the ticket's "(a)
      extend" collapses to "verify + pin".
- [x] cc-parity-2 spec §2 budget-directive row updated in the same PR (plus
      the §9 live-smoke row, which carried the wrong causal claim).

## Bounds

- Interactive-only behavior is guarded by existing ticket-05 tests — not
  regressed (no code change to the handler; the full ultracode suite ran
  green plus the new test).
- Residual fog: the machine's global `keywordTriggerEnabled: false` stands
  (deliberate user preference) — headless arming requires the keyword trigger
  to be enabled per-project or globally, same as interactive.
