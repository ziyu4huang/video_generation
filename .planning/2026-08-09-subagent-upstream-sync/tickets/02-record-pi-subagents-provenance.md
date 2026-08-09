# 02 — Record pi-subagents provenance

---
status: closed
---

## Context

An earlier sync check reported `pi-agent-ext-subagent` had "no upstream" because the
package had NO provenance record. The package-body extraction from `pi-agent-ext-workflow`
(#789) was known, but the 2 watchdog files ported from `pi-subagents` were invisible.
Without a pin record, the watchdog ports get lost and upstream sync misses them.

## Work

Mirror superpowers' provenance practice, scoped to the 2 ports:

1. Create `bun-apps/pi-agent-ext-subagent/docs/upstream/pi-subagents.pin.md` recording the
   selective port: local checkout, origin, reviewed HEAD, ported commit, the 2 ported
   files (with the verbatim-vs-simplified note), the separate package-body upstream, sync
   mechanism (manual selective port), what was applied 2026-08-09, and what is still NOT
   ported (optional feature work gated on upstream scaffolding we lack).
2. Add a short `## Upstream sync` section to `bun-apps/pi-agent-ext-subagent/README.md`
   pointing at the pin file and noting the dual provenance (body ← workflow; watchdog 2
   files ← pi-subagents) in 2-3 lines, matching the README's existing tone.

## Resolution (2026-08-09)

- Added `bun-apps/pi-agent-ext-subagent/docs/upstream/pi-subagents.pin.md` recording the selective port: local checkout, origin, reviewed origin HEAD (`165ec10` / v0.45.1), ported commit (`6216515b` / #937), the 2 ported files with verbatim-vs-simplified notes, the separate package-body upstream (`pi-agent-ext-workflow` #789), the manual-selective-port sync mechanism, the 2026-08-09 `e4f0782` application, and the optional still-NOT-ported files (`scope.ts`, `permission-arbiter.ts`).
- Added a `## Upstream sync` section to `README.md` pointing at the pin file and stating the dual provenance (body ← workflow #789; watchdog 2 files ← pi-subagents) in 2 lines.

This closes the gap that caused the earlier "no upstream" miss — the watchdog ports now have an explicit, discoverable provenance record.
