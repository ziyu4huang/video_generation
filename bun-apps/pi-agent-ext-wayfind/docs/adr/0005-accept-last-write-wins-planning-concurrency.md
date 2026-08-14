**ID:** `ADR-wayfind-0005` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0005: Accept last-write-wins for `.planning/<effort>/` concurrency

Date: 2026-07-27
Status: accepted
See: [superpowers ADR-0005](../../../pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md) (the shared-layout contract), [ADR-0004](./0004-decouple-status-widget-via-global.md)

## Context

wayfind, superpowers, and the core-task plan coordinator all read/write the
**same** `.planning/<effort>/` tree (the unified layout, per superpowers
ADR-0005 "parallel coexistence boundary"). wayfind owns `map.md` + `tickets/`;
superpowers owns `spec.md` / `plan.md` / `sdd/<plan>/` / `brainstorm/`. The
wayfinder skill itself notes: *"the user may run unblocked tickets in parallel,
so expect other sessions to be editing the map dir concurrently."*

Two facts shape the concurrency surface:

1. **wayfind's writes are not atomic and not locked.** `src/map.ts` writes
   `map.md` and `tickets/*.md` via bare `writeFileSync` (no tmp+rename, no
   `proper-lockfile`). The agent's `edit` tool (read-modify-write) is a second
   writer to the same files during a session.
2. **The realistic collision is wayfind↔wayfind on one effort dir** — two
   concurrent wayfinder sessions editing the same `map.md`/ticket, or a session
   racing the user's manual edit. wayfind↔superpowers do **not** collide (they
   write disjoint subpaths).

If two writers interleave a read-modify-write on one file, the later write
silently clobbers the earlier one — a lost update with no error.

## Decision

**Accept last-write-wins. Do not add a file lock or write-detection guard.**

The concurrency model is deliberately last-write-wins, mitigated by the default
that isolates concurrent sessions and by the git recovery net.

## Consequences

- **A lost update is possible but rare.** The default `/wayfind` behavior
  creates a fresh dated effort dir per invocation, so concurrent sessions
  naturally land in *different* dirs. A collision only arises from explicit
  same-effort reuse by two sessions at once — an opt-in, unusual flow.
- **Git is the recovery net.** `.planning/` is committed (`chore(planning):`
  commits land per resolved ticket). A clobbered file is recoverable from
  history; only *uncommitted* concurrent edits are at risk.
- **Isolation on demand.** When true isolation is needed, use distinct effort
  dirs (one per concurrent session) — the default already does this.

## Alternatives considered

- **Atomic writes (tmp + rename).** *Rejected:* atomicity prevents a *torn*
  file (crash mid-write), not a *lost update* across two processes. The
  realistic collision is a read-modify-write race; renaming a whole-file write
  does not serialize it. Solves the wrong failure.
- **Detect-and-warn (mtime/content guard in `map.ts` before write).** *Rejected:*
  cheaper than a lock and would turn the silent loss loud (the ethos of the
  seam-contract guard, `tests/seam-contract.test.ts`), but it only covers
  wayfind's own `writeFileSync` writes — the agent's `edit`-tool writes to the
  same files bypass it → partial coverage that gives a false sense of safety.
- **Advisory lock (`proper-lockfile`, matching hermes-memory's `memory-store`).**
  *Rejected:* the established repo pattern and the only mechanism that truly
  *prevents* a clobber for wayfind-code writes — but it adds a lockfile
  dependency, acquire/release plumbing, and stale-lock/deadlock handling to a
  lightweight human-pace skill workflow, and it **still** cannot cover the
  agent's `edit`-tool writes (the agent does not acquire locks). Incomplete
  coverage for real complexity, against a rare event with a git recovery net.
