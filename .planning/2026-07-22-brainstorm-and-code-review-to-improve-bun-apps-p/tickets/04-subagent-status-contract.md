---
type: grilling
status: open
blocked by: [01-survey-subagent-skill-refs]
---

## Question

How should the SDD status contract (`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`) be surfaced on the `subagent` tool so the controller branches **programmatically** instead of parsing a prose prefix?

Today the implementer returns a prose block whose first line is `- **Status:** DONE | …` and the controller reads it as text. Options to make it machine-readable:

- **A — Dedicated `details.status` enum + convention.** Add a `subagentStatus` (or reuse `details.status`) carrying the SDD enum, populated by instructing the subagent (via the SDD prompt) to emit a parseable marker; the tool parses it into `details`. Lowest friction, no schema burden on non-SDD callers.
- **B — `schema` param with the SDD status object.** A caller passes `schema: { status: enum, commits, testSummary, concerns, reportFile }`; the tool already supports `schema` → structured output. Reuses existing machinery; but forces every SDD dispatch to carry the schema.
- **C — A dedicated `reportSchema`/`contract` param** that pre-bakes the SDD shape so callers don't redeclare it.

Decide: which surface, how the controller consumes it, and how it composes with the existing `done/failed/timedout` process status (they're different axes — process health vs SDD self-report). Keep `CONTEXT.md`'s `subagent (tool)` entry current with the chosen shape.

## First takeable step

Prototype the chosen shape against `implementer-prompt.md`'s Report Format: dispatch a toy implementer, confirm the controller can read `status === "BLOCKED"` and branch without parsing prose. Update `renderSubagentResult` to badge the SDD status.
