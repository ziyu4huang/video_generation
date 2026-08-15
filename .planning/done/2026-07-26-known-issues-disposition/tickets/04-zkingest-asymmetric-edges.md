---
type: grilling
blocked by: []
status: closed
resolved: 2026-07-26 (accept-as-wontfix; PR pending)
---

# 04 — partial zk_ingest re-ingest produces asymmetric 相關 edges

## Fact-finding (2026-07-26, branch synced to 551714ae)

### Mechanism (confirmed in code)

`ingestRecords` (`src/ingest.ts:1345`) builds cross-link edges in step 3
(line 1500):

- a `pool` Map carries **all** cards' tags (existing on-disk + this batch's
  planned) — so planned cards score against the full graph.
- BUT the neighbour-compute loop iterates **only `planned`** (line 1521:
  `for (const p of planned)`). Existing cards are read-only members of the
  pool; their outgoing `相關：[[...]]` edges are **never recomputed**.
- only `planned` cards are re-rendered + written (step 4, line 1543+).

So when card B is ingested and relates to pre-existing card A: B gets its
`相關：[[a]]` edge; A keeps whatever edges it had at its last ingest (no `[[b]]`).
**Asymmetric until A is itself re-ingested.** This is exactly what the ticket
described.

### Empirical repro (bun script, `ingestRecords` in isolation)

Batch 1: ingest A (tags `alpha, shared-bridge`) → A created, 0 links (no
neighbours yet).
Batch 2: ingest B (tags `beta, shared-bridge`) → B created, 1 link.

| card | 相關 edges | links B? |
|---|---|---|
| `b.md` (Beta) | `["a"]` | — |
| `a.md` (Alpha) | `[]` | ✗ **MISSING — asymmetric** |

Result: **B→A exists, A→B does not.** Confirmed.

### The crux — feasibility of "cheap inbound recompute"

The ticket asked whether edge derivation is content-based (recomputable from
Y alone) or pair-based (needs both X and Y). **Answer: content-based via
shared-tag overlap — so the *ranking* is cheap (the `pool` Map already has
all tags in memory).** The blocker is NOT the ranking; it's that
**re-rendering an existing card's body requires its full `KnowledgeRecord`,
which is NOT held in memory** (`existing` only stores
`{abs, tags, sourceId}` via `readCardMeta`, which parses frontmatter only —
not title/detail/confidence/entities).

So symmetrizing would require one of:
- **(a) re-parse each existing card's rendered `.md` back into a record**
  (lossy + fragile — the body is free-form markdown, structured fields were
  flattened on write);
- **(b) in-place text-replace the `相關：[[...]]` block** in existing cards
  (fragile — risks corrupting cards if the block format drifts; doesn't update
  the tag-derived ranking for entities/IDF either);
- **(c) re-ingest from the original source files** (= the documented "full
  re-ingest all sources" workaround — rebuilds symmetrically because every
  card becomes `planned`).

None is "cheap." The data needed for a correct re-render isn't in memory.

### Workaround already exists + is documented

Full re-ingest of all sources rebuilds every card's edges symmetrically
(every card becomes `planned`). KNOWN-ISSUES already flags this. `zk_ask`'s
graph traversal is 2-hop, so a single missing reverse-edge is bridged by the
forward edge + the graph expansion — the asymmetry degrades but does not
break retrieval.

## Decision

**accept-as-wontfix** (grilled 2026-07-26; user accepted recommendation).
The asymmetry is real and empirically confirmed, but the "cheap inbound
recompute" the ticket draft hoped for **does not exist** — the full
`KnowledgeRecord` needed to re-render an existing card was discarded at write
time (`existing` in memory holds only `{abs, tags, sourceId}`). All non-accept
options are either fragile (in-place text-replace of the `相關` block risks
corrupting cards + leaves entities/IDF stale) or equivalent to the existing
full-re-ingest workaround. `zk_ask`'s 2-hop graph traversal bridges single
missing reverse-edges, so retrieval degrades gracefully.

Future note recorded in KNOWN-ISSUES: if a `--recompute-edges-only` flag is
ever wanted, the clean design is to re-ingest from source files (skip the
content-hash unchanged-check so all cards become `planned`) — NOT to re-parse
rendered `.md` cards.

## Fact-finding (2026-07-26, branch synced to 551714ae)
