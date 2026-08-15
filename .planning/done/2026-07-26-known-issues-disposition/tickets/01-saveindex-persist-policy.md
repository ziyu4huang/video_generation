---
type: grilling
blocked by: []
status: closed
resolved: 2026-07-26 (accepted-by-design; doc PR pending)
---

# 01 — saveIndex persist-after-incremental-refresh policy

## Decision

**accept-as-wontfix (accepted-by-design).** (Grilled 2026-07-26; user accepted
the recommendation after seeing the measured cost.)

## Findings (fact-finding + bench, branch behind:0)

The ticket draft assumed this was a "perf gap — next cold start re-scans." That
assumption was **wrong**, and the bench disproved it:

`loadCachedIndex` mtime-validates *every* note on load and re-reads only the
changed files. It does NOT re-scan (read all content). So an incrementally-edited
but unpersisted index cold-starts via the cheap load path, not the full build.

Measured (`scripts/bench-index-persistence.mjs`, 3000-note vault):

| cold-start path | time | when |
|---|---|---|
| `buildIndex` (no cache) | 135ms | baseline / first run |
| `loadCachedIndex` (fresh cache) | 47ms | persisted, nothing changed |
| `loadCachedIndex` (1% stale) | **49ms** | ← this ticket's real scenario |
| `loadCachedIndex` (100% stale) | 155ms | worst case ≈ full build |

- **Typical cost of not persisting = ~2ms** (1% stale vs fresh) — measurement noise.
- **Correctness = zero impact** (mtime self-heal, already documented).
- **Worst case (100% stale bulk)** = 155ms ≈ 135ms full build — persistence
  wouldn't help here anyway (every persisted entry invalidated → full re-read).

## Why not fix

Fixing = persist in `refreshIndex`/`reindexFile`. That requires:
- throttling (else every write path does a 2.6MB disk write), and
- a coherence test (persisted cache survives a simulated restart).

For a sub-5ms saving that's below noise. Net: complexity > benefit. Not worth it.

## Action taken

Corrected the KNOWN-ISSUES entry's wording (it said "re-scan" — should say
"re-read only changed files via mtime-validated load") and recorded the bench
numbers so the rationale is auditable. No code change.
