# Known Issues & Limitations

Living list of known limitations, design constraints, and deferred work for
pi-obsidian. The enhancement goal (`ENHANCEMENT-PRD.md`) is complete; this tracks
what remains by design or for later. Date-stamped; verified state noted.

## Performance

- **`obsidian_search` regex / words / fuzzy modes are full-scan by design.** Only
  `substring` mode uses the C5 trigram inverted index (a literal-substring
  pre-filter is sound; a regex/boolean/fuzzy match is not). At scale, prefer
  `substring` when the query is literal. Substring works **with** a `folder`
  filter too — the candidate set is intersected with the folder by prefix, no
  `listNotes` readdir (a second `listNotes` bottleneck found in self-review;
  see `docs/VALIDATION-C5C6.md`). *(2026-07)*

## Configuration / operational

- **C6 `.cache/` is written inside the vault by default** (`<vault>/.cache/
  pi-obsidian-index.json`). If you git-track or sync the vault folder, add
  `.cache/` to that vault's `.gitignore`, OR set `OB_INDEX_CACHE_DIR` to a path
  outside the vault. The bundled `vaults_root/s2-agent-vault` already ignores it.
  *(documented 2026-07; see README "C6 `.cache/` note")*
- **`obsidian_distill` / `obsidian_garden` need a configured LLM subagent.** They
  spawn `pi` in JSON mode; set `OB_SUBAGENT_MODEL` (and optionally
  `OB_PARENT_MODEL`) for a stable, capable, TC-aware model. Without it the
  subagent falls back to the pi default and warns. *(B2)*
- **Schema cost is ~3.3k tokens/turn** (every tool's description + every param
  description ships in `tools[]` on each request). Run
  `scripts/measure-schema-tokens.mjs` before/after trimming. `obsidian_search`
  alone is ~900 tokens (27%). Further lever: a `minimal` package variant or
  `pi.setActiveTools([...])`. *(C7; conservative on param trims to preserve
  model tool-use)*

## Not yet validated live

- **`obsidian_garden` fix-mode + `obsidian_distill` end-to-end on the real
  vault.** C5/C6 correctness was validated on the 33-note Chinese vault
  (`docs/VALIDATION-C5C6.md`), but the AI-workflow tools' live output was not
  exercised there (no `OB_SUBAGENT_MODEL` in the validation env). Manual
  follow-up once a model is configured.

## Testing

- **Search backward-compat contract is now CI-enforced.** Two distinct concerns
  are decoupled: `baseline-contract.test.mjs` asserts `searchVault`'s
  substring-default output byte-for-byte against a **content-controlled in-package
  fixture vault** (`fixtures/frozen-vault/`) — it has **no submodule dependency**
  and runs everywhere (CI, fresh clone). The older `baseline.test.mjs` remains as
  a *real-vault snapshot* that legitimately drifts on note growth and is
  `skipIf(!vaultAvailable())`-gated. Regenerate either via `bun run
  --cwd bun-apps/pi-obsidian regen:contract` / `regen:baseline`. *(2026-07)*

## Indexing & coherence (audited 2026-07)

A deep read-audit of search/trigram, index reconcile, cache coherence, and the
`zk_ingest` cross-package boundary. Three clear bugs found and fixed — #839
(recency first-key `created:`), #841 (write paths missing reindex → stale-index
false negatives), #843 (`zk_ingest` in-batch duplicate-id → `-2` card). The
soundness-critical paths were **verified clean**: the trigram pre-filter is a
sound over-approximation (never drops a real hit), `expectedMtime` detects lost
updates, `.cache` is self-healing under multi-process access (pid-suffix temp +
atomic rename + per-note mtime re-validation on load), and `zk_ingest` skips
malformed lines per-line rather than crashing the whole run. Remaining non-bug
notes: *(2026-07)*

- **`updateFrontmatter` now uses incremental `reindexFile`.** It was the lone
  `dropIndex` caller among write paths; it now matches `appendUnderHeading` /
  `obsidian_create` / `obsidian_append`, so a held `VaultIndex` reflects a
  just-patched tag/title immediately instead of waiting for the next cold
  `getIndex` rebuild. `moveNote` / `deleteNote` still `dropIndex` deliberately
  (the path key itself changes / the entry is removed).
- **`saveIndex` persists only on a cold `getIndex` build**, not after incremental
  `refreshIndex` / `reindexFile`. **Accepted by design (2026-07 audit).** The
  on-disk cache can lag the in-memory index across a session, but
  `loadCachedIndex` mtime-validates *every* note on load and re-reads only the
  changed files — so a stale cache is self-healing and never affects correctness.
  Measured cost (3000-note vault, `bench-index-persistence.mjs`): a fully fresh
  cache loads in ~47ms; a session that incrementally edited ~1% of notes but
  never persisted still cold-starts in ~49ms (the stale files are re-read on
  load). Even a worst-case 100%-stale bulk session is ~155ms ≈ the ~135ms full
  `buildIndex` it would cost with no cache at all — persistence would not help
  there either, since every persisted entry is invalidated. Persisting after
  every write would add a 2.6MB disk write per write path and require throttling,
  for a sub-5ms saving that falls below measurement noise. Not worth the
  complexity.
- **`byTitle` basename collision is last-indexed-wins.** Two notes sharing a
  basename (`A/Foo.md`, `B/Foo.md`) alias to one `byTitle["foo"]` slot —
  last-indexed-wins. Deleting the winner then leaves the survivor
  **unresolvable by bare basename** (`[[Foo]]` returns undefined) until a full
  rebuild; path-qualified links (`[[A/Foo]]`) are always correct, so use those
  when basenames collide. The `unindexNote` guard already prevents the worse
  variant (a reindexed loser clobbering the winner). Rare in practice
  (~0.2% of basenames in the knowledge vault, all boilerplate files like
  `README`/`Index`/`progress` — never Zettelkasten notes, whose titles are
  unique by `zk_card`'s 4-layer dup check). Accepted as wontfix; fixing would
  require `Map<string, Set<string>>` + a `resolveLink: string[]` contract
  change rippling through 6 consumers — disproportionate to the severity.
- **`zk-ingest` CLI refuses `--source generic`** (`KNOWN_SOURCES` omits it) while
  the `zk_ingest` tool and `host-fns` support it. Explicit error, not a silent
  mis-parse — a surface gap only.
- **Partial `zk_ingest` re-ingest produces asymmetric (directed) `相關：[[...]]`
  edges.** Links are recomputed only for the re-ingested cards; untouched existing
  cards keep their prior outgoing links, so a newly-related card can reach an
  existing one but not vice-versa until that card is itself re-ingested. The edge
  ranking is content-based (shared-tag overlap) and cheap, but re-rendering an
  existing card's body needs its full `KnowledgeRecord`, which is discarded at
  write time (`existing` holds only `{abs, tags, sourceId}`) — so "cheap inbound
  recompute" isn't available without re-parsing the rendered `.md` (lossy) or
  in-place text-replacing the `相關` block (fragile). `zk_ask`'s 2-hop graph
  traversal bridges single missing reverse-edges, so retrieval degrades
  gracefully. Workaround: a full re-ingest of all sources rebuilds symmetrically.
  Future flag, if ever wanted: `--recompute-edges-only` should re-ingest from
  source files (skip the content-hash unchanged-check so all cards become
  `planned`), not re-parse rendered cards.

## Resolved (history)

These were listed as TODOs previously and are now done (kept so the README stays
short; detail in `ENHANCEMENT-PRD.md`):
- **`distill/state.ts:readState` now wraps `JSON.parse` in try/catch** — a
  corrupt `.distill-state.json` resets to the empty default (same as a missing
  file) instead of throwing inside `runConverge` after cards are written. The
  subsequent `writeState` overwrites the corrupt file (self-healing). Covered by
  `__tests__/distill/state.test.ts` (ticket 05, PR #860, 2026-07).
- `renameOverwrite` handles win32 `EPERM`/`EEXIST` via unlink+retry (and `EXDEV`
  via copy+delete); covered by `extensions/__tests__/renameOverwrite.test.ts`
  (Phase 2.1, 2026-07).
- `moveNote` / `deleteNote` parallelize inbound-link rewrites with `Promise.all`
  (Phase 2.2, 2026-07).
- `findBacklinks` reuses `VaultIndex.reverseAdjacency` (C1).
- `graphNeighbors` memoizes undirected adjacency on `VaultIndex.rev` (C2).
- `runSubagent` refactored off the `new Promise(async …)` antipattern (B5).
- Cross-session index persistence exists (C6); substring search has a trigram
  index (C5); tool allowlists are env-driven (B6); the ExtensionAPI contract is
  guarded (C8); path-safety rejects Unicode controls + Windows reserved names
  (A6); writes carry `expectedMtime` optimistic concurrency (A4).
