# Wayfinder map: `/wayfind done` — distill the closing ceremony out of memory

## Destination

A first-class `/wayfind done [effort]` command in **`bun-apps/pi-agent-ext-wayfind/`** that performs the pre-completion self-reflect + next-goal ceremony **structurally** (code), not via a soft global-memory entry. When a map's frontier is clear (all tickets closed / destination reached), the command harvests the effort's own map (`Destination` / `Not yet specified` / `Out of scope`) into an `output/next-goal-<ts>.md` note, runs the tidy SOP, and points at the next concrete goal — so the behavior survives across sessions without relying on the agent remembering to search memory.

1. **Structural trigger** — the closing ceremony is a `/wayfind` subcommand (joining `status`/`spec`/`tickets`/`seed`/`sync`), invoked when the frontier is clear; not a memory the agent must recall.
2. **Grounded harvest** — deferred prizes + completed goals are pulled from the effort's OWN map sections (via the existing `parseMapBody`), not a generic template; the agent fills only the reflective parts (false premises / footguns) it alone knows.
3. **Memory retirement** — the global "before goal_complete: self-reflect + write next-goal" memory entry is superseded (reduced to a pointer or removed); the behavior now lives in code.

## Notes

**Domain:** `bun-apps/pi-agent-ext-wayfind` — the wayfind/wayfinder extension. Pure orchestration functions live in `src/wayfinder.ts` (`statusReport`, `claimNextTicket`, `computeFrontier`); thin command handlers in `src/commands.ts`; map parsing in `src/map.ts` (`parseMapBody`, `Map.notYetSpecified`/`outOfScope`/`destination`).

**Target files:** `src/wayfinder.ts` (new pure `closeEffortReflection()`), `src/commands.ts` (new `handleWayfindDone` + dispatcher `case "done"`), `skills/wayfinder/SKILL.md` (one-line pointer in the handoff section), `tests/wayfinder.test.ts` (pure-function test).

**Standing invariants (do not violate):**
- Wayfind skills are **pi-native/editable** (NO byte-identical fidelity guard — unlike superpowers' ADR-0004). Editing `wayfinder/SKILL.md` is allowed.
- **Bun only**; no top-level `cd`. Wayfind CI gate is `bun run test` (= check + build + test:unit); new code must be biome-clean.
- The closing ceremony's **mechanical** parts (completion check, timestamp filename, harvest, tidy) go in the pure function (testable); the **reflective** parts (false premises, footguns) stay with the agent — the command writes a template the agent fills.
- Reuse the existing SOP: `output/next-goal-YYYYMMDD_HHMMSS.md` filename + `scripts/tidy-next-goals.sh` (keep last 10). Do NOT invent a new convention.

**Existing signals to build on:** `renderStatus` already prints `"frontier: (clear — no open tickets; the way is found)"` when `computeFrontier` is empty (`src/wayfinder.ts:176`) — the "map complete" signal already exists; this effort wires the ceremony to it.

## Decisions so far

<!-- closed tickets — one-line gist, link for detail -->

- [Active vs passive next-goal](tickets/01-active-vs-passive-next-goal.md) — **A: passive + auto-tidy.** `/wayfind done` writes the note + surfaces the next goal (no auto-seeded `/goal`); handler runs tidy. Harvest from `fog`, not `outOfScope`. Distills the old global-memory ceremony into a structural command.
- [Implement /wayfind done](tickets/02-implement-wayfind-done.md) — IMPLEMENTED: `closeEffortReflection` pure fn + `handleWayfindDone` handler + dispatcher/keywords + SKILL.md pointer + 3 tests. `bun run test` 167/0.

## Not yet specified

<!-- fog toward the destination — in scope, not yet sharp enough to ticket -->

- **Nudge from `/wayfind status`.** When the frontier clears, `renderStatus` prints "the way is found" — it could additionally nudge "run `/wayfind done`" so the ceremony isn't missed. (Minor; the SKILL.md pointer already covers the agent path; this is the one genuine deferred prize.)

## Out of scope

<!-- ruled past the destination — never graduates -->

- Auto-running the ceremony without an explicit invocation (too magical; the reflective parts need the agent in the loop). The command is invoked by the user or pointed to by the skill — never fires on a hook silently.
- Changing the `output/next-goal-*` filename SOP or the tidy retention count (reuse as-is).
- Making `/wayfind done` close the effort's tickets (that's `/wayfind sync`'s job; `done` assumes the frontier is already clear).
