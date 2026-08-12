---
status: closed
---

# 05 — knowledge-card: `pi:knowledge` sink subscriber (+ `dir` contract)

## Question

Implement the **sink** side of the wired bus. Contract settled by
[04 — emit contract](04-emit-contract-file2md-to-hub.md) (resolved 2026-08-01). In
`pi-agent-ext-knowledge-card`:

1. **Extend the contract** (`src/emit.ts`): add `dir?: string` to `KnowledgeEmission`, and
   extend `onKnowledge`'s validation gate (today hard-requires `records` | `kbFile`) to also
   accept `dir`.
2. **Register the sink** (`extensions/knowledge-card.ts`): an `onKnowledge` subscriber that,
   best-effort + non-throwing (mirror `emit.ts`'s swallow-on-failure contract):
   - resolves the vault (existing `resolveVault`),
   - routes source-aware to the EXISTING ingest path (the same one `zk_ingest --dir` uses):
     - `dir` (file2md's path) → directory-expansion generic ingest: recurse →
       `adaptGenericMarkdown` per `.md` → `ingestRecords` with `source: "generic"`,
       `sourceLabel` from the payload, landing in the shared `Zettelkasten/knowledge-graph/`
       folder;
     - `kbFile` → `parseKnowledgeJsonl` → ingest;
     - inline `records[]` → ingest as-is.

## Acceptance

- A file2md opt-in emission (per [06](06-file2md-opt-in-knowledge-flag.md)) produces idempotent
  cards in the shared folder (one card per page `.md`, dedup'd by canonical id `generic:<slug>`).
- A second emission of the same doc is a no-op (dedup).
- The sink never throws on a malformed payload (skips + logs at most).
- Existing hermes shutdown-pull convergence is unaffected (this is an additive subscriber).

## type

`task` (AFK-able; the contract is now fully specified by [04]).

## blocked by

— (unblocked: [04](04-emit-contract-file2md-to-hub.md) resolved 2026-08-01).

## claimed

—

## Resolution (closed 2026-08-12 — superseded)

Delivered in code — sink subscriber at `knowledge-card.ts:1495` (`onKnowledge(...) → convergeKnowledgeEmission → ingestRecords`, `converge.ts:61`); superseded by canonical `2026-08-08-knowledge-pipeline` 06b (`walkAndIngest`).
