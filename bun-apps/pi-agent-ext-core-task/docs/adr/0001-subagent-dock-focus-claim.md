**ID:** `ADR-core-task-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-core-task-0001: Subagent dock focus via onTerminalInput prefix-claim

## Status

Accepted (2026-08-15) — implements `.planning/2026-08-15-cc-subagent-tui/` tickets 07–08.

## Context

The TUI routes raw input only to the single `focusedComponent` (the editor); a
`setWidget`-factory dock component's `handleInput?` is never invoked (REVIEW
2026-08-15 subagent finding #1 — the retired subagent-context-widget was
non-focusable and resorted to a `\x0f` byte-sniff). We need interactive keys on
the subagents section WITHOUT any pi-core upstream change.

## Decision

The dock claims focus by PREFIX-CLAIM on `ui.onTerminalInput` (raw-byte path —
no focus required, per the key-path guidance previously recorded at
`subagent-context-widget.ts:24–25`):

- Entry: `Ctrl-G` (`\x07`) followed by `s` arms dock focus mode; the dock then
  CONSUMES subsequent keys until release.
- Release: `Esc` (`\x1b`) returns the dock to passive and stops consuming.

Keymap (table-driven, `DOCK_KEYMAP` — dock.ts owns it):

| Key      | Action                                          |
|----------|-------------------------------------------------|
| `j` / `k` | scroll selection down / up                      |
| `x`      | abort selected run → y/n confirm (x arms, y fires, n cancels) |
| `e`      | expand trace overlay (`formatSubagentTrace`)    |
| `ctrl+b` | detach selected run (`convertToBackground`)     |
| `Enter`  | jump to `/subagents` viewer focused on the run  |
| `Esc`    | release focus claim                             |

Zero upstream pi-core changes. Esc-interrupt of the agent (native Esc) is
untouched: the dock consumes Esc ONLY while it holds the claim.

## Consequences

- While the claim is held, dock keys never reach the editor (consume: true);
  after release no key leaks (single Esc consumed, then passive).
- A future upstream focus API (component-level focus routing) supersedes the
  prefix claim; the migration path is recorded in
  `docs/research-tui-agent-webui-hybrids.md` (#1384) — the dock's public
  interface (`createSubagentDock`) is designed so ONLY the input-claim wiring
  changes, not the keymap or render.
- The byte-level claim is terminal-encoding dependent (raw C0 bytes); the
  prefix key (`Ctrl-G`) must not collide with pi reserved keys — tested via
  the onTerminalInput unit seam, never against a real terminal.
