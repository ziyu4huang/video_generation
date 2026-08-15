## Question

Where do a pack's runtime state bytes (run history, outputs, intermediate artifacts) live, and how does the pack declare them?

type: grilling
status: closed
claimed: chart-session (2026-07-19)

## Resolution

**Pack-local state, never `~/.pi`.** A pack's `outputs/`, `intermediate/`, and `runs/` live **inside the pack folder** (flat top-level dirs — see 04), gitignored. The canonical **folder-structure template ships inside the extension** at `bun-apps/pi-agent-ext-workflow/workflow-pack/template/` (new shipped asset — must be added to `package.json` `files:`). A user's pack is instantiated from that template (mechanics → ticket 07).

**Backward-compat split**: *inline* scripts (the `script` parameter, no pack) keep the existing `~/.pi/workflows/projects/<key>/runs/` run-persistence unchanged; *packs* diverge to pack-local state. (Migration details → ticket 13.)

Rejected:
- **Global store, pack-keyed + manifest contract** — rejected by the user ("no workflow-pack store in `~/.pi`").
- **Hybrid: manifest contract + in-pack state marker** — rejected; the user wants the real bytes pack-local, not a pointer back to a global store.

**ADR-worthy** (hard to reverse — it reshapes where all pack state lives; surprising without context — diverges from the cwd-keyed global store the rest of the engine uses; real trade-off — pack-local fights checked-in packs, see "Not yet specified"). → ADR written: `docs/adr/0001-pack-local-state.md` ✅ (captured 2026-07-19 while the decision was fresh). Full glossary close-out remains ticket 15.
