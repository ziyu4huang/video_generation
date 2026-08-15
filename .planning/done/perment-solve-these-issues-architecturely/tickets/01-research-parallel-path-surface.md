# 01 — Research: the parallel convergence path's full surface (post-ADR-0001)

## Question

What is the FULL surface of every memory→vault convergence path that emits
vault cards outside the canonical `ingestRecords` — the id-namespace each
mints, who triggers each, what state each keeps, and what would have to move
when collapsing to a single path? (The collapse-strategy ticket T02 depends on
this.)

### Context (pre-gathered)

- Canonical path: `zk_ingest` → `ingestRecords` (`src/ingest.ts`) →
  `runConvergenceLoop` (`src/loop.ts`). Idempotent by `record.id`; ships
  `ConvergeReceipt`, `healthGate`, per-family `coverageReport`, opt-in
  wiki-aware Jaccard ≥ 0.85 upsert.
- A memory scar-tissue entry (2026-07-11) claimed "passive-converge + memory
  transfer → `pi-memory:<target>:<hash>`" vs `zk_ingest --source hermes` →
  `hermes:<slug>`. **Suspected stale** — ADR-0001 may have moved things.

type: research
claimed: wayfinder-chart
blocked by: —
status: closed

## Resolution (closed this session — chart-time research pass)

**ADR-0001 already moved convergence ownership to the HUB (knowledge-card),
NOT hermes.** Hermes is a pure TIER-0 foundation with no upward dependency
edge. But the dual-namespace is STILL ALIVE in two emitters:

**Path X — canonical/good:** `convergeHermesMemory(vaultPath, hermesDir)`
(`extensions/knowledge-card.ts:579`) reads every `.md` in the hermes dir,
adapts via `adaptHermesMarkdown`, ingests via `ingestRecords` with
`wikiAware: true`. Mints **`hermes:<slug>`** — deterministic, idempotent,
canonical. Triggered by a `session_shutdown` auto-converge hook
(`knowledge-card.ts:618`) that is **best-effort + silent-fail** (empty
`catch`, "Never blocks shutdown", `OB_HERMES_AUTOCONVERGE=0` disables). Also
reachable via `zk_ingest --source hermes`.

**Path Y — non-deterministic/bad:** `memory transfer` (the `memory` tool's
transfer action, `pi-agent-ext-hermes-memory/src/tools/memory-tool.ts:53` +
`store/memory-store.ts:402`) calls `writeTransferArchive`, which mints
**`pi-memory-<target>-<Date.now()>-<Math.random()>`** (`memory-tool.ts`):
timestamp + `Math.random()` — **NOT a content hash**. Consequence: every
transfer mints a FRESH card; re-transfer never upserts → duplicates accumulate
indefinitely. These `pi-memory:*` cards are then retroactively superseded by
the distill pipeline's `runConverge` (`src/distill/converge.ts`, "mechanism B"
via `markSuperseded`) when an enriched card is written — a messy two-step
workaround for bad ids.

**Invisible-failure tax = the silent-fail shutdown hook.** No receipt is
surfaced from auto-converge; a missing/uninitialized vault, a parse error, or a
transient `SQLITE_IOERR` is swallowed. The "43/52 = 83% unconverged" receipt
was the distill gate's survivors, not a coverage report — there is no
per-entry coverage accounting wired to a human-visible surface today
(`coverageReport` exists but is dry-run/per-family and not surfaced).

**"passive-converge" as a named thing is GONE** (ADR-0001 removed it from
hermes). The concept survives as (a) the hub's shutdown auto-converge and
(b) the transfer-archive emission. The 2026-07-11 memory entry is **partly
stale** — it described the pre-ADR-0001 state.

**Net for T02:** the canonical path to KEEP is `convergeHermesMemory`
(`hermes:<slug>`). The path to KILL/redirect is `writeTransferArchive`
(`pi-memory:<target>-<ts>-<rand>`). The invisible-failure tax is the
silent-fail hook → T03. The distill supersede (mechanism B) is a workaround
that may simplify once ids are deterministic → T02.
