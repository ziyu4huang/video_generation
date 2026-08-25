# s2-agent-ext-power-tool

The ubiquitous language of s2-agent-ext-power-tool — agent self-diagnostics. Two complementary modes: **static diagnostics** that report what is loaded and where tokens go, and **failure pathology** that detects how the agent is failing this session.

## Language

### Diagnostic surface

**Static diagnostic**:
Any `inspect_*` tool that reports the agent's current *state* (loaded tools/skills/extensions, registered hooks, widget state, token distribution, lint findings) at call time, with no session history. The live roster is `TOOL_FACTORIES` in `src/index.ts` — not enumerated here, because an enumeration in prose goes stale.
_Avoid_: health check, debugger, profiler (too generic; these answer "what is loaded?", not "what happened?")

**Failure pathology**:
`inspect_pathology` — the dynamic complement: detects *how* the agent is failing this session (retry loops, error storms, context saturation) by analyzing accumulated tool-call history.
_Avoid_: error log, telemetry, crash report (it is pattern detection over live call history, not a recorded log)

### Pathology detection

**Pathology detector**:
A deterministic, signal-driven check over the session's tool-call history. Implemented as a pure function over a typed input — fully unit-testable without the SDK. The detector set is `analyzePathology()` in `src/pathology/detector.ts`.
_Avoid_: rule, validator, lint, heuristic (it is exact pattern matching over call history, not static source analysis or guessing)

**Accumulator**:
The hook-fed bounded ring buffer that records every `tool_execution_start` / `tool_execution_end` into a per-session, reset-each-`session_start` store the detectors read.
_Avoid_: log, buffer, cache (it is bounded, session-scoped, and fed by lifecycle hooks)

**Historical replay**:
Re-running the pathology detectors over past session transcripts
(`~/.pi/agent/sessions/**/*.jsonl`) instead of the live accumulator. The detectors
are unchanged — `analyzePathology()` is already pure over `PathologyInput`, so replay
only builds that input from a transcript. Because nothing derived is stored, a
threshold change re-derives the entire history consistently.
_Avoid_: backfill, import, migration (nothing is written; every number is recomputed)

**Environment sidecar**:
The one-line-per-session record of facts a transcript cannot reconstruct — HEAD sha
and the loaded-tool fingerprint — appended at `session_start` to
`~/.pi/agent/power-tool/env.jsonl`. Carries no derived metric by design.
_Avoid_: telemetry, log, metrics (it records environment identity, never measurements)

**Occurrence rate**:
Sessions in which a pathology fired ÷ sessions **containing at least one tool call**.
The denominator excludes tool-less sessions deliberately: 2,226 of 3,391 measured
sessions have no tool call and cannot trigger any detector, so including them tracks
prompt volume rather than agent behaviour.
_Avoid_: frequency, count (a count series is dominated by long sessions)

**Volatility-relative threshold**:
The per-check bar a rate move must clear to earn a `regressed` / `improved` verdict:
the largest window-to-window move that check made *before* the pair under judgement,
floored by `--delta`. Excluding the judged pair stops a jump from licensing itself.
Max rather than mean or sigma — "larger than anything this check has ever done" is
deterministic and needs no distributional assumption.
_Avoid_: significance, confidence, baseline deviation (there is no p-value and no
distribution model — see [[Pathology detector]], which is signal-driven, not heuristic)

**Proactive warning**:
The non-invasive status-line nudge (`⚠ retry loop: bash ×3`) surfaced automatically when a *high*-severity pathology is active — a status bar line only, no context injection and no turn hijack.
_Avoid_: alert, notification, interrupt (it never injects into the model context)

**Finding**:
A severity-tagged issue emitted by `inspect_extensions` or `inspect_pathology`, shaped `{ severity, id }` (e.g. `{ high, "retry-loop" }`).
_Avoid_: issue, error, violation

### Severity & cost

**Severity framework**:
The shared `high` / `medium` / `low` / `info` ranking reused by both `inspect_extensions` and `inspect_pathology`, so every diagnostic speaks one vocabulary.
_Avoid_: severity levels, ranking

**schema-cost**:
The static tool-token estimator — estimates a tool's per-request cost from its description + parameters schema (guidelines and the repeated tool name are NOT measured), no model call. Also exported as a standalone publishable package.
_Avoid_: token counter, cost calculator

**Extension token tax**:
The per-extension estimated tokens-per-request breakdown the static diagnostics report (sorted desc with a % bar) — answers "which extension is heaviest?" Measured once, in `src/cost.ts` over `schema-cost/`.
_Avoid_: token usage, cost breakdown
