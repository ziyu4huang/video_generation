# pi-obsidian — Knowledge-Layer Role

> This package is the **HARD forward dependency** of
> [`pi-knowledge-card`](../../pi-knowledge-card). The Obsidian parser + subagent
> contracts exported here are load-bearing for the whole knowledge graph.

## What pi-knowledge-card consumes from here

| Export (in `extensions/obsidian.ts`) | Used by pi-knowledge-card for |
| ------------------------------------ | ----------------------------- |
| `parseFrontmatter` | reading card frontmatter (tags, source_id, P1 feature flags) in `ingest.ts` + `retrieve.ts` |
| `validateZettelNote` + `ZETTEL_MAX_BYTES` + `ZETTEL_REQUIRED_KEYS` | the card-validation gate (`id`/`created`/`tags` + `tags[0]=="zettel"`; additive keys ride along) |
| `getIndex` / `graphDeadLinks` / `graphOrphans` / `invalidateCache` | `retrieveRecords`'s `graphHealth` + `healGraph` (dead-link/MOC-drift/orphan audit) |
| `runSubagentWithRetry` | the runner the 4 tools (`zk_extract`/`zk_card`/`zk_ask`/`zk_ingest`) spawn their isolated subagents through |

## Why this matters (contract drift)

A change to **`parseFrontmatter`'s scalar/list parsing** or to
**`validateZettelNote`'s required-keys rule** ripples directly into
pi-knowledge-card's deterministic ingest + retrieval. The P1 feature keys
(`has_callouts`, `callout_types`, …) rely on `parseFrontmatter` round-tripping
booleans (`true`) and flow lists (`[warning, tip]`) — if parsing regresses,
`readCardMeta().hasCallouts` silently goes false and the callout ranking boost +
digest surfacing stop firing.

## Drift guards already in place

- `pi-knowledge-card/__tests__/allowlists.test.mjs` — loads the **real**
  pi-obsidian extension and asserts every `obsidian_*` tool named in the
  allowlists is registered here. Catches tool renames/removals at test time.
- `ingest.test.ts` / `retrieve.test.ts` — exercise the parser round-trip
  against real temp vaults (booleans, flow lists, additive keys).

## Cross-links

- Canonical dependency graph: [`../../pi-knowledge-card/docs/DEPENDENCIES.md`](../../pi-knowledge-card/docs/DEPENDENCIES.md)
- Architecture: [`../../pi-knowledge-card/docs/ARCHITECTURE.md`](../../pi-knowledge-card/docs/ARCHITECTURE.md)
- Data model (card frontmatter schema): [`../../pi-knowledge-card/docs/DATA-MODEL.md`](../../pi-knowledge-card/docs/DATA-MODEL.md)
- The knowledge-layer arc: [`../../pi-knowledge-card/docs/PR-HISTORY.md`](../../pi-knowledge-card/docs/PR-HISTORY.md)
