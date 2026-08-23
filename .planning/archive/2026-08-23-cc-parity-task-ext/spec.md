# cc-parity-task-ext — design spec

Effort: `2026-08-23-cc-parity-task-ext`. Reference agent: Claude Code (harness tool
descriptions and command surface read first-hand 2026-08-23; external research
confirmation appended when it lands).

## §1 Problem

Three surfaces in this repo diverge from their Claude Code counterparts in ways that
cost transfer of learned behavior — model-facing prompt semantics, user-facing command
syntax, and agent-facing skill conventions:

1. `ask_user_question` — schema limits, recommended-option convention, preview rules,
   and plan-mode guidance all differ from CC's `AskUserQuestion`.
2. `/loop` — ours is a process-improvement loop; CC's is recurring prompt execution.
3. `wizard` — teaches bash template authoring in a Bun-first repo.

## §2 Goals / non-goals

**Goals**

- A model that has learned CC's AskUserQuestion behavior produces CC-equivalent calls
  against `ask_user_question`, and gets equivalent answers back.
- `/loop <interval> <prompt>` works the CC way: recurring, idle-gated, session-persisted.
- Wizard skill authors Bun wizards, verified with Bun-native syntax checks.
- goal loses its four dead coupling sites to the old loop.

**Non-goals**

- Rewriting `/goal` (superset, kept).
- Dynamic self-pacing / a ScheduleWakeup-equivalent tool (see map Fog of war).
- Durable cron files, 7-day expiry, jitter — CC's session-loop has none of these.
- Touching ask-user features that are already supersets of CC (Esc-to-quit, collapse
  key, multi-question tabs, RPC fallback, webui external answers).

## §3 Decisions

- **D1 — Full-depth alignment for ask_user_question** (user, 2026-08-23): prompt
  semantics AND schema AND TUI behavior — not description-only.
- **D2 — Recommended moves to label-suffix convention.** Drop the `recommended`
  boolean from the schema; the description teaches "(Recommended)" label suffix +
  first position (CC's exact convention). TUI detects the suffix, renders ⭐, strips
  the suffix from display. Existing tests that author `recommended: true` migrate to
  the suffix form. Reason: the schema field is the one thing CC's model never sees;
  keeping it would keep our prompt guidance permanently forked.
- **D3 — /loop replaced wholesale** (user, 2026-08-23), architecture A (pure timer
  scheduler). No compat layer for the old `start "target" measure=…` syntax. Reason:
  the process-improvement semantics have no CC counterpart, and their goal⇄loop
  mutual-exclusion seam was pure coupling cost.
- **D4 — wizard template.sh → template.ts (Bun)**, deleted not deprecated. SKILL.md
  rewritten; `bash -n`/shellcheck replaced by `bun build --target=bun` as the syntax
  gate. Library-above-STAGES-marker invariant preserved verbatim in TS form.
- **D5 — /goal untouched except dead-coupling removal (revised 2026-08-23).** CC HAS
  `/goal` (docs-verified): `condition|clear` surface, small-model per-turn evaluator,
  Not-yet-met/Met/Impossible verdicts. s2-agent's /goal is a functional superset
  (`reviewer.ts` ≈ the evaluator) — the machinery stays; only the four dead coupling
  sites to the old loop are removed. A surface-syntax parity pass (aliases, verdict
  naming, 4,000-char cap) is charted in map Fog of war as a possible ticket 04.
- **D6 — Session-only loop lifetime.** Loop state persists to the session for restart
  recovery but never to disk-as-cron. CC's /loop is CronCreate-backed and inherits the
  7-day recurring auto-expiry; we mirror that as a **7-day max-age cap** on the
  session loop (fires one last time, then self-deletes) rather than as durable cron.
  Jitter stays unported — CC's jitter exists to de-synchronize fleet-wide cron storms;
  a local session timer has no such contention.
- **D7 — Tickets are independent.** 01/02/03 share no code paths; order is by value,
  not dependency.

## §4 Design

### §4.1 ask_user_question (ticket 01)

Schema (`tool/types.ts`):

- `MAX_HEADER_LENGTH` 16 → 12; description updated to CC wording ("Very short label
  displayed as a chip/tag; max 12 chars", examples "Auth method", "Library").
- `label`: drop the 60-char hard rejection; description becomes CC's "concise (1-5
  words)". A widened guardrail stays only if the wrap-regression tests require one —
  decided in-ticket against `question-wrap-regression.test.ts` / `footer-hint-wrap-regression.test.ts`.
- `recommended` field deleted (D2). `too_many_recommended` error and
  `reserved_label` guards that reference it are reworked accordingly.
- `preview`: validation rejects `preview` on any option of a `multiSelect` question
  (CC: "previews are only supported for single-select"); description rewritten to
  CC's ("Use for ASCII mockups of UI layouts or components, code snippets, diagrams,
  or config examples. Preview content is rendered as markdown in a monospace box …
  switches to a side-by-side layout"). New error kind `preview_on_multiselect`.
- `question`/`options`/`multiSelect` descriptions aligned to CC phrasing, including
  multiSelect's "phrase the question accordingly; do not use for mutually exclusive
  choices".

Tool description (`ask-user-question.ts:86-98`) rewritten to CC's structure:
numbered when-to-use list; usage notes covering custom-answer row, Esc, multiSelect,
recommended convention (suffix + first, no duplicate conventions); preview feature
paragraph; and a plan-mode paragraph adapted to `src/plan/` (clarify requirements
BEFORE finalizing a plan; never use the tool to ask "is the plan ready" — that is the
plan-approval flow's job). `DEFAULT_PROMPT_SNIPPET` / `DEFAULT_PROMPT_GUIDELINES`
follow suit.

TUI: ⭐ rendering keyed off "(Recommended)" suffix detection (display strips the
suffix); preview side-by-side rendering audited against the components in
`view/components/preview/` and brought to CC shape only where it is already close —
new rendering engines are out of scope (non-goal: this is alignment, not a rewrite).

Answer envelope: unchanged — `answers[].kind/answer/selected/notes/preview` already
covers CC's answers+annotations shape.

### §4.2 wizard Bun port (ticket 02)

`template.ts` mirror of `template.sh`'s library: `stage`, `say`/`step`, `openUrl`
(cross-platform incl. WSL), `ask`/`askSecret` (hidden entry), `writeEnv` (idempotent
upsert), `setSecret`/`setVar` (gh CLI), `pause`/`confirm`, `TOTAL_STAGES`. Stages
authored below the `STAGES` marker; library above it never hand-edited. Syntax gate
`bun build --target=bun <file>`. SKILL.md rewritten: description, body, and verify
step all speak Bun; `template.sh` deleted.

### §4.3 /loop replacement (ticket 03)

New `src/loop/` (replaces all six current modules):

- Command: `/loop [interval] <prompt...>` with `interval` ∈ `s|m|h|d` units
  (CC: seconds round up to the nearest minute; `1d` supported), default 10m;
  `/loop stop`; `/loop status`. Completions follow CC's example syntax
  (`/loop 5m /foo`). CC's prompt-only mode (agent picks its own interval) and its
  interval-only maintenance prompt are NOT ported (dynamic mode = Fog of war;
  maintenance prompt = YAGNI).
- Scheduler: one timer chain per session; on fire, if `isIdle()` → `sendUserMessage`
  (prompt as-is), else postpone to next idle transition; re-arm after each fire.
- Persistence: loop target persisted to the session (existing persistence approach);
  restored on session start only if still within its lifetime semantics (session-only,
  D6). Stop clears it.
- Overlay: simplified — interval, target, next-fire time, iteration count.
- Deletions: `loop-metric.ts`, plateau/anti-repetition halves of `loop-state.ts`,
  `buildLoopContinuationPrompt`/continuation-marker machinery, and the goal coupling
  at `goal/hooks.ts:254-255` (runLoopTick), `goal/lifecycle.ts:54`,
  `goal/status.ts:116,129` (heartbeat supervision returns to goal-only). The
  `before_agent_start` marker-clearing hook in `registerLoop` goes with it.
- Tests: current `src/loop/__tests__/` rewritten for scheduler semantics (interval
  parse, idle-gating, stop, persistence round-trip); goal tests updated where they
  referenced loop-active branches.

## §5 Risks

- Dropping `recommended: true` breaks any persisted/older callers — accepted under D2;
  the tool description is the model's only contract and it changes atomically with the
  schema in one ticket.
- Idle-gating depends on `isIdle()` fidelity; if it misreports, the loop could fire
  mid-turn. Mitigation: postpone-on-busy re-checks after each agent_end-equivalent
  event; integration test covers the busy→idle transition.
- `/loop <interval> /slash-cmd` targets are Fog-of-war; ticket 03 ships prompt-only if
  the programmatic command-invocation probe fails.

## §6 Parity ledger

| Aspect | Claude Code | This effort's outcome |
|---|---|---|
| header | ≤12 chars | 16→12 |
| label | concise 1-5 words | 60-char rejection dropped (guardrail per wrap tests) |
| recommended | "(Recommended)" suffix + first | field deleted; suffix convention + ⭐ render |
| preview | single-select only, monospace md, side-by-side | validated single-select; description aligned; render audited |
| plan-mode guidance | clarify before ExitPlanMode; never "plan ready?" | adapted to `src/plan/` |
| questions/options | 1-4 / 2-4 | already parity |
| /loop syntax | `<interval> <prompt\|slash-cmd>`, default 10m; units s/m/h/d (s rounds up) | same units; prompt targets; slash targets if probe lands |
| /loop firing | only while idle | idle-gated, postpone-on-busy |
| /loop lifetime | session-only cron, 7-day auto-expire | session-only timer, 7-day max-age cap (D6) |
| /goal | exists: `condition\|clear`, small-model evaluator, Met/Impossible verdicts | kept as functional superset; surface parity charted, not built (D5) |

### §6.1 Research receipts (2026-08-23)

External confirmation via docs research: header ≤12, options 2-4, questions 1-4,
Other-option + custom-text answer, side-by-side monospace preview
(`code.claude.com/docs/en/agent-sdk/user-input`, GitHub issue #33062); /goal existence
and semantics (`code.claude.com/docs/en/goal`); /loop modes/units/7-day expiry
(`code.claude.com/docs/en/scheduled-tasks`). Research could not verify label length,
preview single-select restriction, or the "(Recommended)" suffix convention — all
three are taken FIRST-HAND from the CC harness's own AskUserQuestion tool
description (this effort's reference surface, read 2026-08-23), which is more
authoritative than docs for model-facing behavior.
