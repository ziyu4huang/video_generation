# Ticket 03 — background-agents panel key: recorded no-go (ADR-subagent-0004 amendment)

Status: done (2026-08-25 — resolved as a DOCUMENTED NO-GO per the user's
second confirm-gate; no code change, no key registered)

## Direction history (two confirm-gates)

1. First gate (charting): map D4 directed **alt+b** as the CC Ctrl+B
   panel-opener — chosen over reclaiming ctrl+b (cursorLeft collision,
   ADR-subagent-0004). That recommendation rested on "alt+b is free",
   which implementation-time measurement DISPROVED.
2. Measurement (2026-08-25, pi dists on this machine): `alt+b` is one of
   `tui.editor.cursorWordLeft`'s defaults (`alt+left`/`ctrl+left`/`alt+b`,
   pi-tui dist/keybindings.js). Registering it re-creates ADR-0004's exact
   failure mode: a startup conflict diagnostic every launch (the extension
   would WIN the key — restrictOverride is false — but at the cost the ADR
   already rejected) plus shadowing the editor's readline M-b word-left.
3. Second gate: the user chose **skip the new key** ("跳過新鍵(記
   no-go)") over accepting the warning or switching to a free key such as
   alt+p.

## Disposition (map D5)

- **No global panel-opener key.** The background-agents surface stays
  reachable via its two existing scoped surfaces: the dock focus claim
  `ctrl+g s` (runs-gated; ext-task dock-claim.ts) and the `/subagents`
  command.
- ADR-subagent-0004 gained a 2026-08-25 amendment recording the no-go, the
  alt+b measurement, and the measured free alt+<letter> space (built-ins
  claim only b/d/f/v/y + non-letters; alt+p is the clean candidate should a
  future effort revisit).

## Done-when

- [x] alt+b collision measured and recorded (ADR amendment + this ticket).
- [x] No key registered; shortcut-guard surface unchanged (nothing to add).
- [x] Map: D5 recorded, t03 closed as no-go, Frontier → effort close-out.
- [ ] PR (docs-only) merged CLEAN via the devops chain.
