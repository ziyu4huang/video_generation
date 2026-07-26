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
  outside the vault. The bundled `vaults_root/pi-agent-vault` already ignores it.
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
  `refreshIndex`. The on-disk cache can lag the in-memory index across a session;
  `loadCachedIndex`'s mtime validation makes this a minor perf gap, never
  correctness.
- **`byTitle` basename collision is last-indexed-wins.** Two notes sharing a
  basename (`A/Foo.md`, `B/Foo.md`) alias to one `byTitle["foo"]` slot; reindexing
  one can steal the key, and deleting it then leaves the survivor unresolvable by
  basename. Inherent ambiguity of basename/title linking.
- **`zk-ingest` CLI refuses `--source generic`** (`KNOWN_SOURCES` omits it) while
  the `zk_ingest` tool and `host-fns` support it. Explicit error, not a silent
  mis-parse — a surface gap only.
- **Partial `zk_ingest` re-ingest produces asymmetric (directed) `相關：[[...]]`
  edges.** Links are recomputed only for the re-ingested cards; untouched existing
  cards keep their prior outgoing links, so a newly-related card can reach an
  existing one but not vice-versa until that card is itself re-ingested. Inherent
  to incremental upsert; a full re-ingest of all sources rebuilds symmetrically.
- **`distill/state.ts:readState` does a raw `JSON.parse` with no try/catch.** A
  corrupt `.distill-state.json` would throw inside `runConverge` after cards are
  already written. Not a valid-input trigger, but wrapping it would make converge
  robust to state-file corruption.

## Resolved (history)

These were listed as TODOs previously and are now done (kept so the README stays
short; detail in `ENHANCEMENT-PRD.md`):
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
