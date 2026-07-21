# 03 — The completeness invariant + making failure loud

## Question

What is the precise, **checkable invariant** for "every memory entry converged
exactly once," and **how is a failed or silent convergence made LOUD** instead
of swallowed?

### Context (pre-gathered)

The invisible-failure tax is the `session_shutdown` auto-converge hook being
**silent-fail** (`knowledge-card.ts:618`: empty `catch`, "Never blocks
shutdown"). `coverageReport` (per-family E−V id-diff) and `healthGate`
(dead-links / MOC / orphans) already exist as dry-run primitives but are not
surfaced to any human-visible health state.

### Decide

- **The invariant.** Is it per-source-family coverage (`coverageReport`'s
  E−V — "every hermes entry has a vault card") or full source-traceability
  ("every vault card ↔ a source entry, both directions")? The latter may force
  the `generic`/obsidian direct-write dual-write into scope (see map's *Not yet
  specified*) — pin which.
- **The surface.** Extend `/memory-health` to show convergence coverage + the
  last receipt, or add a `/converge-verify`? Does the shutdown hook emit a
  receipt to a known location (instead of swallowing) that health reads?
- **The failure semantics.** When convergence can't complete (vault missing,
  parse error, transient I/O), is the right behaviour fail-loud-at-shutdown,
  defer-and-retry-next-session, or write-a-receipt-and-warn? (Interacts with
  T04 wrong-vault and T06 SQLite noise.)

type: grilling
claimed: wayfinder-session
blocked by: 02
status: closed

## Resolution (closed this session)

**Unidirectional completeness + durable receipt + on-demand surface.**

**Decision 1 — invariant shape: UNIDIRECTIONAL.** Invariant =
`coverageReport.missing.length === 0` — every source entry has a vault card
(the E−V direction). `sourceOrphaned` (V−E) is REPORTED but NOT gated, so
legit direct-writes (generic/obsidian) and legacy dupes (T05) don't violate it.
Measurable now via the existing `coverageReport` + `source-watchlist`
(`.pi/kcard-coverage.json`). This RULES the vault dual-write OUT of scope
(fog graduated → Out-of-scope).

**Decision 2 — failure + surface: durable receipt + on-demand.** The shutdown
auto-converge hook writes its `IngestSummary` receipt to disk
(`.pi/kcard-last-receipt.json`: created/updated/missing/errors) instead of
discarding it in the empty catch; NEVER blocks shutdown; an on-demand surface
reads the receipt + runs `coverageReport`. Failure = recorded in the receipt +
warned (not thrown). The exact surface name (extend `zk_ingest --coverage` vs a
new `/memory-health`) is T07's call — that ticket IS the enforcement-surface
decision.

**Build includes (implementation, not separate tickets):**
- The shutdown hook captures the `IngestSummary` `convergeHermesMemory` already
  returns (today discarded) and writes `.pi/kcard-last-receipt.json`; on error
  writes `{error, ts}` to the same file. No more empty `catch`.
- `coverageReport` wired to include the archive source post-T02 (so `missing`
  counts evicted-but-unconverged entries too).
- Receipt location is cwd-relative (`.pi/`); whether health reads per-session
  receipts or a vault-level rollup is decided in T07.

**Unblocks:** T07 (enforcement surface — now has the receipt + coverageReport
as its inputs).
