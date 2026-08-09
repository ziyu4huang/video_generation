---
type: grilling
status: closed
claimed: chart-session-2026-07-23
---

## Question

Does `/wayfind done` merely **write** the next-goal file + notify (passive — matches the original memory behavior), or does it also **actively propose/seed** the next goal from the top deferred prize (active)? And does it run `scripts/tidy-next-goals.sh` itself, or leave tidy to the user?

- **A — Passive + auto-tidy.** `/wayfind done` harvests the map, writes `output/next-goal-<ts>.md` with the structured parts pre-filled (completed goals, deferred prizes from `Not yet specified`/`Out of scope`, a recommended next goal = top deferred prize), runs tidy, and notifies the path + the recommended next goal. It does NOT set a `/goal` or auto-continue — the user/agent picks up the next goal explicitly. Matches the original memory behavior; keeps the ceremony a discrete, inspectable step.
- **B — Active.** A also writes the file, but additionally seeds the next `/goal` (or publishes an overlay nudge) from the top deferred prize, so the handoff into the next effort is one step. More momentum; risks presupposing the next goal before the reflective parts (false premises/footguns) are even filled in.
- **C — Bare skeleton.** Command writes only a blank template (no harvest); the agent fills everything. Least code, but throws away the grounded-harvest value (the whole point of distilling into the extension).

## First takeable step

Settle A vs B (the active/passive axis is the real fork; C is a downgrade). If A, the pure function's contract is: `closeEffortReflection(cwd, effort) -> { path, nextGoal, deferredPrizes } | { refused }`, invoked once, no side effects beyond the file + tidy.

## Resolution

**A — passive + auto-tidy.** `/wayfind done` harvests the map, writes `output/next-goal-<ts>.md` with structured parts pre-filled, runs `scripts/tidy-next-goals.sh`, and notifies the path + recommended next goal. It does NOT set `/goal` or auto-continue — the user/agent picks up the next goal explicitly. Grounded in the original memory behavior (which the user called "good memory" — passive, write-file); distilling = preserve the behavior, make it structural. B rejected: seeding `/goal` presupposes the next goal before the reflective parts (false premises/footguns) are filled — premature. C rejected: discards the grounded-harvest value (the whole point).

**Harvest source correction:** deferred prizes come from `WayfindMap.fog` (the "Not yet specified" section) — NOT `outOfScope` (which is explicitly "never graduates", the opposite of a prize). Recommended next goal = the first `fog` bullet.
