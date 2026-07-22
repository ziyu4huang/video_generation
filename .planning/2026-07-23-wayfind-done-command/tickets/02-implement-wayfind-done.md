---
type: task
status: closed
blocked by: [01-active-vs-passive-next-goal]
claimed: chart-session-2026-07-23
---

## Question

Implement `/wayfind done` per ticket 01's resolution, plus the SKILL.md pointer, plus a pure-function test.

## What to build

1. **`src/wayfinder.ts`** — new pure function `closeEffortReflection(cwd, effort)`:
   - Load the map (`loadMap`/`parseMapBody`); if `computeFrontier(map.tickets)` is non-empty → return `{ refused: "N open ticket(s) remain on <effort>; resolve them (or /wayfind sync) first" }`.
   - Harvest: `destination` (completed-goal framing), `notYetSpecified` + `outOfScope` (deferred prizes, split into bullet lines).
   - Build the next-goal note body from a template (mirror `output/next-goal-20260723_033037.md`'s structure: Goal completed / false premises _(agent fills)_ / footguns _(agent fills)_ / deferred prizes _(pre-filled from harvest)_ / next concrete goal _(= first deferred prize, marked recommended)_).
   - Write `output/next-goal-<YYYYMMDD_HHMMSS>.md` (local time, matching `tidy-next-goals.sh`'s canonical format).
   - Return `{ path, nextGoal, deferredPrizes: string[] }`.
2. **`src/commands.ts`** — `handleWayfindDone(args, ctx)`: resolve effort (arg or active), call the pure function, `ctx.ui.notify` the path + recommended next goal (or the refusal). Add `case "done": return handleWayfindDone(...)` to the dispatcher + `"done"` to `WAYFIND_KEYWORDS`. Update the `/wayfind` description string.
3. **Tidy** — the handler shells `bash scripts/tidy-next-goals.sh` (best-effort; ignore if absent) after writing, so retention holds.
4. **`skills/wayfinder/SKILL.md`** — one line in the handoff/closing area: "When the frontier is clear (all tickets closed), run `/wayfind done [effort]` to write the self-reflect + next-goal note." (pi-native skill — editable.)
5. **`tests/wayfinder.test.ts`** — pure-function test: a fake map with empty frontier + populated `Not yet specified`/`Out of scope` → `closeEffortReflection` writes a file whose body contains the harvested deferred prizes + the recommended next goal; and a non-empty-frontier map → `{ refused }`.

## Acceptance

- [ ] `/wayfind done <effort>` writes `output/next-goal-<ts>.md` with harvested deferred prizes pre-filled, refuses when the frontier is non-empty.
- [ ] Pure function is tested (harvest + refuse paths); `bun run test` green (check + build + test:unit).
- [ ] `wayfinder/SKILL.md` points to `/wayfind done`; biome-clean.
- [ ] Dispatcher + `WAYFIND_KEYWORDS` + command description updated.

## First takeable step

After 01 resolves, write `closeEffortReflection` pure function + test first (TDD), then the thin handler + dispatcher wiring, then the SKILL.md one-liner.

## Resolution

**IMPLEMENTED + verified** (`bun run test` = biome check + tsc build + test:unit → **167 pass / 0 fail**).

- **`src/wayfinder.ts`** — pure `closeEffortReflection(cwd, effort, now?)`: `readMap` → refuse if `computeFrontier` is non-empty (or no map); harvest `map.fog` as deferred prizes; `nextGoal` = first fog bullet (fallback when empty); write `output/next-goal-<YYYYMMDD_HHMMSS>.md` via `renderNextGoalNote` (destination framing + false-premises/footguns placeholders for the agent + pre-filled prizes + recommended next goal). Returns `{path, nextGoal, deferredPrizes, effort} | {refused}`. Mechanical parts here; reflective parts stay with the agent.
- **`src/commands.ts`** — `handleWayfindDone` (resolve effort → call pure fn → best-effort `spawnSync("bash", ["scripts/tidy-next-goals.sh"])` → notify path + recommended goal, or the refusal); wired into the dispatcher (`case "done"`), `WAYFIND_KEYWORDS`, the header doc-comment, and the `/wayfind` description.
- **`skills/wayfinder/SKILL.md`** — "When the map is complete" paragraph in the work-the-map steps: run `/wayfind done` (refuses if open tickets remain), with a by-hand fallback.
- **`tests/wayfinder.test.ts`** — 3 tests: refuse-on-open-frontier, refuse-on-no-map, harvest-when-clear (fixed-timestamp → deterministic filename + pre-filled prizes + bolded next goal).

Design (decision 01): **passive** — writes the note + surfaces the next goal, does NOT auto-seed `/goal`; **auto-tidy** in the handler. Harvest source = `fog` ("Not yet specified"), NOT `outOfScope` (which is "never graduates").
