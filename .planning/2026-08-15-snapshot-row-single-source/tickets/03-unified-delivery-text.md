# Ticket 03 — Unified delivery text (`deliverText` + `deliverTextFromPersisted`)

> Wave 1 · spec §2.3 · status: open

## Goal

Merge the two near-duplicate result-delivery builders in `task-panel.ts`:

- `deliverText(run: ManagedRun)` — `task-panel.ts:82–90` (live run + `WorkflowRunResult`)
- `deliverTextFromPersisted(run: {...})` — `task-panel.ts:181–197` (persisted-only, structurally
  typed)

into one builder over a common input subset (result, agentCount, tokenUsage.total, durationMs,
name + lead-sentence variant). The persisted path sources its fields **through the ticket-1
adapter** (persisted → snapshot → shared builder) rather than re-reading raw
`PersistedRunState`, so a future unmapped field cannot fork the two texts.

## Acceptance criteria

- Single builder; `deliverTextFromPersisted`'s field assembly is gone (only the lead-sentence
  difference remains as data).
- Persisted path flows through `persistedToSnapshot` (ticket-1 adapter) — no direct raw-field
  reads duplicated from the snapshot shape.
- Regression test: for the same underlying run, live and adapter-persisted inputs render
  identical summary/tokens/agents/duration segments (leads differ as designed).
- Gate: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`.

## Files

- `bun-apps/pi-agent-ext-workflow/src/task-panel.ts`
- `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (import of adapter, if not already)
- `bun-apps/pi-agent-ext-workflow/tests/` (dual-path regression)

## Dependencies

- Ticket 01 (adapter must exist and be exported before the persisted path rides it).
