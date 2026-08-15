---
type: prototype
status: closed
claimed: work-session-2026-07-22
---

## Question

How deep should subagent-run capture go, and how is it exposed in `/subagents` and the live trace?

Current state (from `agent-history.ts` + `subagent-viewer.ts`):
- `compactAgentHistory` keeps ≤40 entries, ≤2000 chars/text, ≤20000 total — tool **names** and tool-result **text**, but tool-call **arguments** are `JSON.stringify`'d wholesale and the live trace (`formatHistoryLine`) shows only `→ toolName` / `← toolName ✓`.
- `/subagents` output view shows the **final text the parent read** (`content[0].text`), NOT the child's full message transcript.

Target (per scope: full transcript + tool args):
- Capture the child's full message transcript (tool calls **with arguments** + results), not just the compact history tail.
- Expose it in `/subagents` (a "transcript" view beyond the final-output view) and surface tool args in the live trace (collapsed by default, expandable).

Decide: capture depth (full messages vs a richer compact form), where it lives (`AgentHistoryEntry` extension vs a new transcript capture on `WorkflowAgent.run`), the `/subagents` viewer UX (a third view tab), and the size/cost guardrails (full transcripts are large — cap + truncate policy). Keep the shared `renderActivityRow` as the one-line language.

## First takeable step

Prototype a richer `AgentHistoryEntry` (add `arguments?` to `toolCall`) flowing through `formatSubagentLive` with a collapsed/expanded render; measure a real run's transcript size to set the cap.

## Resolution

Prototype landed + verified (`bun run build` clean, 1176/1179 tests pass). Four design decisions settled:

1. **Capture depth — richer compact form, NOT full raw messages.** `compactAgentHistory` ALREADY captures tool-call arguments (as a compact JSON string in `AgentHistoryEntry.text`) and tool-result text. Full raw messages are too large and buy nothing for debugging; the compact form is sufficient. **No new capture field was needed** — the gap was purely rendering. (This narrows ticket 08: persist the compact history, not full messages.)

2. **Live-trace rendering — DELIVERED.** `formatHistoryLine` now surfaces a ≤100-char preview of tool-call args + tool-result text on each expanded trace line (`src/subagent-tool.ts`: new `previewPayload()` helper + enriched `formatHistoryLine`). Bare `{}` args are suppressed (no noise); the collapsed 2-line header is unchanged (stays terse). Expanded trace now reads as a real transcript (`→ read {"path":"src/foo.ts"}` / `← read ✓ export const x = 1;`) instead of bare call markers.

3. **`/subagents` transcript view — DESIGNED, deferred for completed runs.** A third view (list → output → transcript, keyed e.g. on `t`) rendering the compact history. RUNNING runs can show it now (in-flight registry already holds `history`); COMPLETED runs cannot — the child transcript is in-process and gone after completion, and the session branch holds only the final tool result. **So the completed-run transcript is a consequence of ticket 08 (disk persistence)**, which already lists the transcript among what it persists. No new ticket; 08's scope is confirmed.

4. **Cap policy — keep the existing compact caps** (`maxEntries=40`, `maxTextChars=2000`, `maxTotalChars=20000`); live-trace previews truncated to ≤100 chars/line; trace capped at `maxTraceLines=100`. No change.

**Artifact:** `src/subagent-tool.ts` (`previewPayload` + `formatHistoryLine`), `tests/subagent-tool.test.ts` (+2 tests: arg/result preview surfaced; bare `{}` suppressed). Build clean; full suite 1176 pass / 0 fail.

**Graduated:** the completed-run-transcript question is no longer fog — it is owned by ticket 08. No new tickets.
