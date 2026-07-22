---
type: grilling
status: closed
claimed: work-session-2026-07-22
blocked by: [01-survey-subagent-skill-refs]  <!-- 01 closed → unblocked -->
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

## Resolution

Grilled (2 decisions) + implemented + verified.

**Decision 1 — mechanism: parse the prose prefix into a dedicated field.** The SDD self-report status is a DIFFERENT axis from the tool's process status (`done`/`failed`/`timedout`) — a run can finish (process done) while self-reporting BLOCKED. claude-code's controller parses the `**Status:**` prefix; we do the same (parity), reading the byte-identical prompt's OUTPUT (never editing the template). Rejected: schema enforcement (fights the prose-expecting byte-identical prompt) and a dedicated contract param (API surface for marginal gain). `schema` stays available for callers wanting hard guarantees (the paths don't compose — a schema result is JSON, no prose marker).

**Decision 2 — scope: parse the FULL report block, not just the status enum** (full-parity preference). `details.report?: SddReport` carries `{ status, commits?, testSummary?, concerns?, reportFile? }`. `status` is parsed reliably (fixed enum, one canonical marker, case-insensitive → normalized); the rest are best-effort (`undefined` when not cleanly present). The controller branches on `report.status`; the rest are hints.

**Execution details (decided, not grilled):**
- `parseSddReport` returns `undefined` when no `**Status:**` marker → plain dispatches / schema results / failures carry no report.
- `details.report` is a NEW field on `SubagentToolDetails`, separate from `details.status`.
- `renderSubagentResult` badges `SDD:<status>` (warning tint for BLOCKED/NEEDS_CONTEXT/DONE_WITH_CONCERNS via `isSddReportActionable`; success tint for DONE).
- The report is persisted on the `SubagentRunRecord` (ticket 08) for replay.
- `SddReport` / `SddReportStatus` / `parseSddReport` / `isSddReportActionable` / `SDD_REPORT_STATUSES` are public exports (full parity — peer extensions/controllers branch on them).

**Artifact:** `src/sdd-report.ts` (new), `src/subagent-tool.ts` (`details.report` + render badge), `src/subagent-run-persistence.ts` (`report?` on the record), `src/index.ts` (public exports), `CONTEXT.md` (`SddReport` entry), `tests/sdd-report.test.ts` (8 tests). Build clean; workflow 1195/0 fail.

**Graduated / noted:** a real dispatch against a model is the next fidelity check (the parser is unit-tested against the prompt's canonical shape; a live run confirms the marker survives real model output). The `commits` regex over-matches hex (documented best-effort).
