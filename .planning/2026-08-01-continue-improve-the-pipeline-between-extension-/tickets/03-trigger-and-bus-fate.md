# 03 — Trigger + orphaned-bus fate

## Question

How should opt-in file2md conversions trigger convergence, and what becomes of the orphaned
`pi:knowledge` event bus?

## Resolution

**Closed during the charting grill (2026-08-01).**

**Wire the `pi:knowledge` bus.** When file2md runs with `knowledge:true`, it emits on the bus
(payload-only, no hub import); knowledge-card adds a sink subscriber that forwards to
`ingestRecords`.

Chosen because it:
1. **Preserves ADR-0001's TIER-0 purity** — no file2md→hub upward dependency edge. The bus is
   exactly the no-edge mechanism `src/emit.ts` was built for ("a content extension that learns
   something DURING a session can emit a knowledge record without knowing whether a sink is
   attached").
2. **De-orphans an existing dead contract** — `emitKnowledge`/`onKnowledge` are defined but no
   emitter and no sink exist today; the real hermes convergence is a shutdown *pull*, not a bus
   *push*.
3. **Converges immediately on-conversion** — no shutdown scan, no persistent opt-in marker
   needed (the flag is known at conversion time).
4. **Generalizes** to any foundation extension that learns during a session.

Rejected:
- **Shutdown-pull (mirror hermes)** — would need a PERSISTENT opt-in marker (frontmatter /
  sidecar) + a re-scan every session.
- **Direct call** (file2md imports knowledge-card, calls `ingestRecords`) — simplest code, but
  creates the upward dependency edge ADR-0001 deliberately avoids.
