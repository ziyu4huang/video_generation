# Wayfinder map: 2026-07-25-what-more-inspect-tool-need-add-for-pi-agent-ext

## Destination

A **go/no-go verdict** on whether power-tool's inspect-* surface is sufficient
to support **pi-agent extension development** — the activity chain load
verification → cost measurement → hook observability → runtime debugging →
contract validation → context-dependent judgment. Reached by (1) confirming
whether the one open gap — **hook observability** (no inspect tool shows which
extensions registered which `pi.on(...)` handlers, or whether they fired) — is
buildable, and (2) setting the bar for whether that gap is severe enough to
warrant a new tool. If **go** (sufficient) — document "the inspect-* surface is
complete for extension dev; stop" and list hook observability as a known,
accepted limitation. If **no-go** — graduate the gap (candidate: `inspect_hooks`)
into a fresh effort with a spec; the graduation is fog here, not a live ticket.

This is a *decision* destination, not a feature destination: judge first, invest
second. The disciplined outcome "the surface is complete — stop" is a legitimate,
welcome resolution.

## Notes

- **Domain** — `bun-apps/pi-agent-ext-power-tool/`: agent self-diagnostics.
  Static tools (`inspect_agent` / `inspect_context` / `inspect_extensions` /
  `inspect_tui`) report state; `inspect_pathology` detects how the agent is
  failing this session. Plus the `extension-auditor` subagent (judgment layer
  over `inspect_extensions`) and the `schema-cost` estimator (the measurement
  engine behind `inspect_context` / `inspect_extensions`).
- **"Previous self-reflections" (this map's input)** — harvested from
  power-tool's own PRD / docs / README:
  - *LLM-judged pathology* (goal-drift, quality-degradation) — explicitly
    **deferred**, blocked on the repo's `--offline` zero-egress discipline.
  - *Tool-Search lazy dispatcher for `inspect_*`* (candidate D) — explicitly
    **rejected** (non-fog, closed).
  - *extension-auditor subagent* — **shipped**, the judgment layer.
  - *schema-cost publishable package* — exported, low-fog.
  None of these reflections named **hook observability** — that gap surfaced
  from mapping the extension-dev activity chain, not from the docs.
- **Scope pins (settled at chart time, 2026-07-25)** —
  - Destination shape = **decision-destination** (judge sufficiency; "complete,
    stop" is a valid resolution).
  - Judgment criterion = **activities 3–8** of the extension-dev chain (load
    verification → runtime debugging). Authoring / registration-wiring (1–2) is
    "writing," not inspect's job — excluded.
  - **Surface boundary**: the auditor subagent + schema-cost **count** as the
    inspect-* surface (they ARE the diagnostics surface; the auditor is
    `inspect_extensions`' documented judgment layer). → **activity 8
    (context-dependent judgment) is COVERED.** Verdict narrows to activities
    3–7, of which only **5 (hook observability)** is an open gap (3/4 covered;
    6/7 partial-but-available).
  - **LLM-judged pathology is OUT OF SCOPE** here — it serves *agent
    self-monitoring*, not *extension-development debugging*.
- **Skills every session should consult** — `wayfinder`, `grilling`,
  `grill-memory`, `domain-modeling`.
- **Keystone research already done (chart-time fact-gathering)** — the pi SDK
  (0.82.0) exposes `getAllTools(): ToolInfo[]` (tools enumerable) but has **no**
  `getAllHandlers()` / `getHooks()` / equivalent; hook registrations are not
  readable back through any API. So the gap is real at the SDK level, not merely
  an unbuilt tool. The feasible path is `pi.on()` instrumentation (wrap `on` at
  the power-tool factory, record `(extension, event, handler)` into an
  accumulator) — the same technique `sdk-patch.ts` (wraps `createContext`) and
  `inspect_pathology` (instruments `tool_execution_*`) already use in this
  codebase. Ticket [01] confirms this with a cheap spike.

## Decisions so far

- [Verdict threshold](tickets/02-verdict-threshold.md) — bar = "GO iff every HIGH-impact in-scope gap covered or accepted-as-limitation"; hook observability classified **HIGH** impact (cold-set, before [01]). Decision rule locked: HIGH + feasible → **NO-GO** (graduate `inspect_hooks`); HIGH + needs-upstream-SDK-change → **GO** w/ accepted limitation.
- [Hook observability feasibility](tickets/01-hook-observability-feasibility.md) — **feasible, no SDK change.** Supersedes the "wrap pi.on" idea (per-instance `on` can't capture others). Instead read the aggregate `runner.extensions[].handlers` (`Map<event,handler[]>`) via the `sdk-patch.ts` `createContext` polyfill pattern (expose a `getHooks()` on ctx). Registration listing near-trivial + order-independent + attribution free (`ext.path`); firing observability feasible as phase-2 handler-wrapping. → per [02]'s rule, [03] is now **determined: NO-GO → graduate `inspect_hooks`.**
- [The verdict](tickets/03-the-verdict.md) — **NO-GO: the inspect-* surface is NOT yet sufficient for extension development.** [02] classified hook observability HIGH (cold) + [01] confirmed it closeable without an SDK change → the locked rule fires NO-GO. Graduated `inspect_hooks` to a fresh effort (seed spec at `../2026-07-25-inspect-hooks-hook-observability/spec.md`) → hand to writing-plans. **Map complete — all tickets closed; destination reached.**

## Not yet specified

<!-- Map complete (2026-07-25): all three tickets closed; destination reached.
     The one fog patch (inspect_hooks output shape/scope) GRADUATED into the
     fresh effort at ../2026-07-25-inspect-hooks-hook-observability/spec.md —
     it is handed off, not deferred. No remaining fog in this map. -->

_(none — the inspect_hooks design fog graduated with [03] into its own effort; nothing deferred here.)_

## Out of scope

- **LLM-judged pathology** (goal-drift via reasoning comparison, silent
  quality-degradation trend). Deferred in the prior reflections for good reason:
  it needs a runtime LLM-as-judge call the repo's `--offline` zero-egress
  discipline forbids for a diagnostic. More fundamentally it serves *the agent
  monitoring its own goal*, not *a developer debugging their extension* — a
  different destination. Belongs to a separate effort, after the
  offline-local-model architecture question is settled.
- **Tool-Search lazy dispatcher for `inspect_*`** (the README's "candidate D").
  Closed decision: rejected because hiding inspect params behind a help
  round-trip hurts the zero-round-trip self-diagnosis these tools exist for. Not
  re-opening.
- **Code-health work on the existing surface** (splitting the 1,241-line
  `src/index.ts`, deduplicating the `/4` token heuristic with tool-gate). Those
  improve *existing* capability, not *new* inspect-* capability — a different
  effort (the index.ts split + coverage loop are tracked under the sibling
  2026-07-25 coverage spec).
- **Authoring / registration-wiring support** (activities 1–2). That is "writing
  the extension," not "inspecting/debugging it" — outside the diagnostic mandate
  that defines this destination.
