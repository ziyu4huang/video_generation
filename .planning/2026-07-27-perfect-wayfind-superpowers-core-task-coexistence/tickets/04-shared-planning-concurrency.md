# 04 — Shared `.planning/<effort>/` concurrency

---
type: grilling
blocking:
status: closed
claimed: wayfinder-session
---

## Question

Both wayfind and superpowers (and the core-task plan coordinator) read/write the **same** `.planning/<effort>/` tree. The wayfinder skill itself says "expect other sessions to be editing the map dir concurrently," yet **neither wayfind nor superpowers uses file locking** (hermes-memory uses `proper-lockfile`; these two don't). Two concurrent sessions editing `map.md` or the same ticket can collide and silently clobber. Is this a real seam to harden, and if so, how — without over-engineering a mostly-single-user flow?

## What to build

A grilled decision on whether the shared `.planning/` concurrency surface needs a guard. Candidate mechanisms to grill:
- **advisory lock** (`proper-lockfile`, matching hermes-memory's pattern) on the effort dir or per-file;
- **atomic writes** (tmp+rename, which the wayfinder skill already implies for run-persistence) generalized to map/ticket writes;
- **accept** — concurrent multi-session editing of one effort is rare enough that last-write-wins + the existing git safety net suffices.

The decision should weigh actual collision likelihood (is the effort dir ever truly multi-writer?) against the complexity a lock adds to a tool that's meant to be lightweight.

## Acceptance
- [x] A decision: harden (which mechanism) or accept (with the rationale documented).
- [x] If hardening: the chosen mechanism is specified and its scope (effort-dir vs per-file) justified. *(N/A — accepted, not hardened.)*

## Resolution

**Accept last-write-wins; document, do not harden.** Two grilled sub-decisions, both confirmed against the recommendation:

1. **Harden vs accept = ACCEPT.** Rationale: the collision is **rare** (the default `/wayfind` behavior creates a fresh dated effort dir per invocation, so concurrent sessions naturally land in *different* dirs — a collision needs explicit same-effort reuse by two sessions at once); `.planning/` is git-committed (recovery net); and any code-level guard has **incomplete coverage** — wayfind's own `writeFileSync` writes could be locked/detected, but the agent's `edit`-tool writes to the same files cannot (the agent doesn’t acquire locks), so a guard gives a false sense of safety. Adding lock/deadlock complexity to a lightweight human-pace flow isn’t worth it against a rare event with a git net.
2. **Doc location = a new wayfind ADR-0005 + a sharpened wayfinder-skill caveat** (not amend superpowers ADR-0005, not skill-only). wayfind owns the colliding `map.md`/`tickets/` surface; a focused ADR is discoverable + permanent; the skill caveat lives where the “expect other sessions” note already is.

**Deliverable:**
- `pi-agent-ext-wayfind/docs/adr/0005-accept-last-write-wins-planning-concurrency.md` — states the model, the rarity + git-net mitigation, and **rejects** the three alternatives with rationale: atomic writes (solve *torn* files, not *lost updates* — wrong failure), detect-and-warn (partial coverage — only wayfind-code, not agent edits), advisory lock `proper-lockfile` (incomplete coverage + real complexity, matching hermes-memory but unjustified here).
- `wayfinder/SKILL.md` line ~136 sharpened: states the last-write-wins model, links the ADR, and names the mitigation (distinct effort dirs / git).

**Verified:** all 3 ADR cross-reference targets resolve; no wayfind test pins the edited skill line; full wayfind suite 177 pass / 0 fail.

**Classification (per the ticket’s framing):** the `.planning/` concurrency surface is **accepted-as-documented** (no test-guard, no lock) — distinct from the `__pi*` seams (tickets 02/03, test-guarded) because the failure mode is a rare concurrency race, not a structural drift that’s certain on change.
