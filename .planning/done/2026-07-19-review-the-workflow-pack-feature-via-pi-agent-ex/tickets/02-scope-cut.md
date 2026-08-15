## Question

How far does this effort reach — core self-contained unit, core + lightweight feedback record, or full self-improving work-unit?

type: grilling
status: closed
claimed: chart-session (2026-07-19)

## Resolution

**Core unit; self-improve deferred.** In scope (this map's destination):
- Canonical **folder template** (flat top-level dirs).
- **Manifest I/O contract** (input source, output/intermediate/history policy + retention).
- **Repeat-run semantics** (versioned/comparable outputs).
- **Cleanable / purgable pack-local history** (agent can inspect + purge).
- **Bundled Claude-Code-compatible subagent definitions** inside the pack.
- **On-disk intermediates** (new engine capability — forced by the cleanability goal).

Out of scope (north star → separate future effort): the per-pack feedback record, quality-verdict accumulation, and the agent-driven "improve this pack" proposer. The unit must exist and be used before improvement data exists to consume. A manifest `version` field (ticket 08) is kept as harmless groundwork for that future effort, but no feedback loop is built here.
