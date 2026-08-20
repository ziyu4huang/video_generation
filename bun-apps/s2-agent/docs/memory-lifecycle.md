# Memory Lifecycle — the WRITE-side State Machine

> **Status:** canonical as of 2026-07-11 (Track 1, Phase 1.1 of the
> `memory-orchestration` cycle). Companion to
> [`knowledge-orchestration.md`](./knowledge-orchestration.md) (the 3-layer model
> + the promotion flow) — that doc explains *what* the layers are; this one
> explains *how a learning moves between them*, trigger by trigger, and how to
> tell if the flow is healthy.
>
> **Scope:** the WRITE side only — how a session insight gets from working memory
> (`pi-hermes-memory`) into the durable vault (`s2-agent-ext-obsidian` +
> `s2-agent-ext-knowledge-card`). The READ side (retrieval architecture) is a
> separate cycle (Track 2/3).

## The flow, trigger by trigger

A learning enters working memory via the detectors (`correction-detector`,
`error-detector`, `background-review`, or the manual `memory` tool). From there,
**four** mechanisms can promote it into the durable vault. They differ in *when*
they fire, *what* they touch, and *how they fail*.

```
                         working memory                      durable vault
                  ~/.pi/agent/pi-hermes-memory/        vaults_root/.../knowledge-graph/
                  {MEMORY,failures,USER}.md  (§-sep)            (atomic zettel cards)
                          │
        ┌─────────────────┼──────────────────────────────────────────┐
        │  (1) detectors write here during a session (the ONLY writers to .md)│
        ▼                                                                     │
   ┌────────────┐   (A) memory transfer   ┌──────────────────┐                │
   │  entry in  │ ──────(manual)──────────▶│ convergeToVault  │── card(s) ────▶│
   │  working   │                          │ (vault-converge) │                │
   │  memory    │   (B) passive-converge   │  soft dynamic    │                │
   └────────────┘ ────(session_shutdown)──▶│  import of KC +  │                │
                   (C) auto-consolidate     │  obsidian        │                │
                   ────(capacity)──────────▶│  ⚠️ NOT vault →  │                │
                   (D) zk_ingest --source   │  within-store   │                │
                   ────(manual CLI)────────▶│  compaction only │                │
                                          └──────────────────┘                │
```

## The four triggers

| # | Trigger | Fires when | Reads | Writes | Idempotency | Failure mode |
|---|---------|-----------|-------|--------|-------------|--------------|
| **A** | `memory transfer` (tool action) | user-invoked | working `.md` entries (via `transferEntries`) | `.knowledge.jsonl` archive + vault cards (via `convergeToVault`) | wiki-aware match (Jaccard ≥ 0.85) + stable content-hash id `pi-memory:<target>:<hash>` | **visible** — returns the converge result to the user; falls back to the archive file if the peer is absent |
| **B** | `passive-converge` (`session_shutdown` handler) | automatic, every session end | new/changed entries (delta vs idempotency state) | vault cards + `.vault-converge-state.json` (hashes) + **`.vault-converge-health.json`** (run log) | per-target entry-hash state file; unchanged entries skipped | **best-effort, bounded (5s), never throws** — outcome persisted to the health file; check via `/memory-health` |
| **C** | `auto-consolidate` (`setConsolidator`) | when a store hits capacity | the overflowing `.md` target | **the same `.md`** (compacted by an LLM child process) | none (lossy by design — it *summarizes*) | **NOT a vault convergence** — it compacts working memory in place; the parent reloads from disk after |
| **D** | `zk_ingest --source hermes` (CLI) | manual | the `.md` files directly | vault cards + MOC | wiki-aware + id-dedup (byte-deterministic; re-run is a no-op) | **loud** — CLI errors are visible; deterministic so safe to re-run anytime |

> **The trap to know:** triggers **A**, **B**, **D** all converge into the vault
> through the *same* `convergeToVault` / `ingestRecords` sink, so the wiki-aware
> matcher keeps them from duplicating each other (the same lesson → one canonical
> card regardless of which trigger moved it). Trigger **C** is different — it
> never touches the vault; it only shrinks working memory. They are
> complementary, not redundant.

## Trigger B in detail (the one that used to be silent)

`passive-converge` is the automatic path — "your sessions save themselves." It
runs on `session_shutdown`, after the session-flush handler, before the DB-close
handler (registration order in `src/index.ts` block 11b/12).

**What makes it healthy now (Phase 1.2):** every run writes a record to
`.vault-converge-health.json` capturing, per target (`failure`/`memory`/`user`):
`seen`, `newEntries`, `converged`, `skipped`, `status` (`ok`/`failed`/`unavailable`),
and a `reason` when not ok. The `overall` status is the worst case across targets.
This closed the old defect where a broken vault resolution or a missing
knowledge-card peer converged silently to nothing.

**The `unavailable` subtlety:** when the knowledge-card/obsidian peer isn't
installed, `passive-converge` *still records the entry hashes* (so it doesn't
retry every session) but flags the run `unavailable`. That is correct behavior
(standalone-safe), but it means **convergence isn't actually happening** — the
health record + `/memory-health` now surface this so it isn't mistaken for success.

## How to tell if the flow is healthy

```
/memory-health
```

A no-LLM, no-network command (`src/handlers/converge-health-command.ts`). It shows:

1. **The last run** — status icon, `overall`, age, trigger, per-target counts, and
   the `reason` if it failed/was unavailable.
2. **A live reconciliation** — for each target, how many working-memory entries are
   NOT yet in the vault right now (computed by hashing current `.md` entries
   against `.vault-converge-state.json`). This is the "is the flow keeping up?"
   signal: a growing `unconverged` count means lessons are accumulating in working
   memory without reaching the durable graph.

> **Ground truth = the `.md` files.** The reconciliation reads entries via the
> `MemoryStore` getters (which parse the `.md`), NOT the SQLite index (which
> lags). It tolerates concurrent modification — it's a best-effort point-in-time
> snapshot; re-run to refresh.

## When to use which trigger

| You want to… | Use |
|--------------|-----|
| Force-converge specific entries now (and remove them from working memory) | `memory transfer` (A) — moves entries out |
| Let sessions save themselves automatically | nothing — `passive-converge` (B) does it on shutdown |
| Free space in a bloated working store | `auto-consolidate` (C) / `/memory-consolidate` — compacts in place (NOT vault) |
| Re-converge the whole working store deterministically after edits | `zk_ingest --source hermes` (D) — idempotent copy, working memory stays intact |
| Check if convergence is actually working | `/memory-health` |

## See also

- [`knowledge-orchestration.md`](./knowledge-orchestration.md) — the 3-layer model,
  the promotion-flow diagram, and the `memory transfer` vs `zk_ingest`
  distinction (this doc is the trigger-level complement).
- `s2-agent-ext-hermes-memory/src/store/vault-converge.ts` — the soft-import seam
  (A and B both go through it).
- `s2-agent-ext-hermes-memory/src/store/converge-health.ts` — the health + state
  bookkeeping (B's observability layer).
- `s2-agent-ext-hermes-memory/src/handlers/converge-health-command.ts` — the
  `/memory-health` command.
