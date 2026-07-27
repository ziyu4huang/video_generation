# 04 — Shared `.planning/<effort>/` concurrency

---
type: grilling
blocking:
status: open
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
- [ ] A decision: harden (which mechanism) or accept (with the rationale documented).
- [ ] If hardening: the chosen mechanism is specified and its scope (effort-dir vs per-file) justified.
