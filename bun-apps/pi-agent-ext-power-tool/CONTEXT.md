# pi-agent-ext-power-tool

The ubiquitous language of pi-agent-ext-power-tool — agent self-diagnostics. Two complementary modes: **static diagnostics** that report what is loaded and where tokens go, and **failure pathology** that detects how the agent is failing this session.

## Language

### Diagnostic surface

**Static diagnostic**:
One of `inspect_agent`, `inspect_context`, `inspect_extensions` — reports the agent's current *state* (loaded tools/skills/extensions, token distribution, lint findings) at call time, with no session history.
_Avoid_: health check, debugger, profiler (too generic; these answer "what is loaded?", not "what happened?")

**Failure pathology**:
`inspect_pathology` — the dynamic complement: detects *how* the agent is failing this session (retry loops, error storms, context saturation) by analyzing accumulated tool-call history.
_Avoid_: error log, telemetry, crash report (it is pattern detection over live call history, not a recorded log)

### Pathology detection

**Pathology detector**:
A deterministic, signal-driven check over the session's tool-call history (`retry-loop`, `consecutive-error`, `error-storm`, `context-saturation`, `long-session-recall-risk`). Implemented as a pure function over a typed input — fully unit-testable without the SDK.
_Avoid_: rule, validator, lint, heuristic (it is exact pattern matching over call history, not static source analysis or guessing)

**Accumulator**:
The hook-fed bounded ring buffer that records every `tool_execution_start` / `tool_execution_end` into a per-session, reset-each-`session_start` store the detectors read.
_Avoid_: log, buffer, cache (it is bounded, session-scoped, and fed by lifecycle hooks)

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
The static tool-token estimator — estimates a tool's per-request cost from its schema + description + guidelines, no model call. Also exported as a standalone publishable package.
_Avoid_: token counter, cost calculator

**Extension token tax**:
The per-extension estimated tokens-per-request breakdown that `inspect_extensions` and `inspect_context` report (sorted desc with a % bar) — answers "which extension is heaviest?"
_Avoid_: token usage, cost breakdown
