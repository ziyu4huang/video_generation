# Ticket 04 — Typed `runStatusGlyph()` replaces both `STATUS_ICON` maps

> Wave 1 · spec §2.4 · status: open

## Goal

Delete the two untyped `STATUS_ICON: Record<string, string>` maps and their silent `"?"`
fallbacks:

- `workflow-commands.ts:17–25` (used at `:32`, `:94`, `:115`, `:287`)
- `workflow-ui.ts:33–45` (used at `:399`; smeared map also covering agent statuses)

Replace with one `runStatusGlyph(status: RunStatus): string` backed by an exhaustive
`Record<RunStatus, string>` (`RunStatus` from `run-persistence.ts:10`): **a new status missing a
glyph is a type error, not a `"?"`**. Agent-status glyphs delegate to `activityGlyph`
(`core-runtime/agent-row-display.ts:106`) where a site was leaning on the smeared map.

## Acceptance criteria

- Both `STATUS_ICON` maps deleted; zero `?? "?"` status fallbacks remain.
- `runStatusGlyph` is total over `RunStatus` by construction (exhaustive record); typecheck
  fails if a status is added without a glyph.
- Runtime test asserts every `RunStatus` value yields a non-`"?"` glyph.
- Rendered output byte-identical; existing tests green.
- Gate: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`.

## Files

- `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (or `display.ts`) — `runStatusGlyph`
- `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts`
- `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts`
- `bun-apps/pi-agent-ext-workflow/tests/` (totality regression)
