# Validation Report — C5 (trigram search) & C6 (index persistence) on real + at-scale vaults

PR #148 shipped C5 and C6 measured only on 3000 synthetic ASCII notes. PRD C6
required "measure win on the 10k-note reference vault" — open. This run closes
that gap: **correctness on the real (Chinese) vault + scale at 10k**, and it
surfaced two real issues (one fixed).

Runner scripts: `scripts/validate-real-vault.mjs`,
`scripts/bench-trigram-search.mjs`, `scripts/bench-index-persistence.mjs`.

## 1. Real-vault correctness — PASS

Vault: `vaults_root/s2-agent-vault` — a **33-note Chinese Zettelkasten** (English
titles, Chinese bodies, real `[[wiki-link]]` graph). `validate-real-vault.mjs`
(`OB_INDEX_CACHE_DIR=/tmp/...` keeps the submodule pristine):

- `obsidian_status` → 33 notes (matches disk).
- **C5 search equivalence** across ~40 queries — `obsidian_search` with trigram
  candidates ON == trigram OFF == brute-force substring scan. Covers:
  - CJK ≥3 chars (` obsidian`, CJK tokens) — **confirms trigram is sound on
    Chinese** (UTF-16 code-unit slicing; BMP chars are 1 unit).
  - CJK <3 chars (`整合`, `背景`, `讓` …) — trigram returns null → full scan,
    still equivalent (sound, just unaccelerated).
  - ASCII, handpicked (`知識管理`, `obsidian`), and an absent token.
- `obsidian_query` (tag filter) == `byTag` on the real tag graph (5 tags sampled).
- **C6 round-trip** on the real link graph: `getIndex`→`saveIndex`→`dropIndex`→
  `loadCachedIndex` → notes/tags/per-note title/backlinks/CJK-trigram-candidates
  all equal to a fresh build. Confirms persistence preserves `resolveLink`/
  `reverseAdjacency` semantics.
- `obsidian_garden` audit subagent skipped (needs a configured `OB_SUBAGENT_MODEL`;
  out of C5/C6 scope — distill/garden live runs are a manual follow-up).

Result: **0 failures.** C5/C6 are correct on real Chinese content + a real graph.

## 2. Scale benchmark at 10k (synthetic)

### C6 — clear, consistent win

| metric | value |
|---|---|
| cold `buildIndex` | 472 ms |
| cold `loadCachedIndex` (stat-only) | 172 ms |
| **speedup** | **2.74×** (matches the 2.76× at 3k — scales) |
| 1%-stale load (100 changed files) | 179 ms |
| `.cache` size | 8.8 MB (~0.9 KB/note) |
| loaded == built (notes/tags/trigrams/backlinks) | ✓ |

### C5 — issue found & fixed (5–10× after fix)

First run showed only **~1.1×** at 10k (no better than 3k). Root cause:
`searchVault` opened with `listNotes(folder)` — an O(n) `readdir` — **before**
applying the candidate path set, so the trigram filter saved file reads but not
the `readdir`, which dominated at scale.

**Fix** (`extensions/obsidian.ts`, searchVault): when an explicit `paths`
candidate set is supplied AND no folder restriction is in play, skip `listNotes`
and use the candidate set directly. 322 tests stay green; correctness unchanged
(candidates are a sound superset).

After the fix:

| query | candidate set | trigram-on | full-scan | **speedup** |
|---|---|---|---|---|
| `supercalifragilistic` | 1000/10000 (10%) | 10.1 ms | 100.3 ms | **9.9×** |
| `meeting` | 2000/10000 (20%) | 20.7 ms | 101.0 ms | **4.9×** |

Result set == brute force on every query. The win scales with how rare the query
is (rarer → smaller candidate set → faster), exactly as a trigram index should.

#### Second `listNotes` bottleneck — folder × substring (found in self-review)

A re-read of `searchVault` after the first fix surfaced the **same bug class
again**: the skip-`listNotes` optimization was gated on `!folder`, so a
substring search **with a `folder` filter** fell back to the O(n) `listNotes`
readdir even though the trigram candidate set had already scoped the work. The
caller (`obsidian_search`) always passes `folder` through, so any folder-scoped
substring search silently lost the C5 speedup — and the benchmark above missed
it because it only ran folder-less queries (`paths: ALL_PATHS`).

**Fix** (`extensions/obsidian.ts`, searchVault): when an explicit candidate set
is present, intersect it with the folder by **prefix** (`p.startsWith(folder+"/")`)
instead of re-enumerating the vault. `listNotes` now runs only for unscoped
searches (no candidate set). Result correctness is unchanged (the candidate set
is a sound superset; the folder is a hard scope). Regression tests added in
`trigramIndex.test.mjs` (folder × candidate intersection, incl. an empty-folder
case). Same lesson as the first fix, restated: **a candidate pre-filter is
worthless if an O(n) enumeration runs alongside it — measure every code path
that can reach the filter, not just the one the benchmark happens to exercise.**

## 3. Issue found: `.cache/` vault pollution (fixed)

C6 writes `<vault>/.cache/pi-obsidian-index.json`. The submodule's `.gitignore`
did **not** ignore `.cache/`, so any default run left an untracked `.cache/` in
the vault — observed live during this validation.

Fixes:
- `vaults_root/s2-agent-vault/.gitignore` now ignores `.cache/` (submodule commit
  `0aed7d8`, pushed; parent pin bumped in this branch).
- README "Environment variables" documents `OB_INDEX_CACHE_DIR` (relocate outside
  the vault) + a "C6 `.cache/` note" telling users to add `.cache/` to their own
  vault's `.gitignore`. The env-var table was also refreshed to cover all the
  knobs added across the enhancement goal (`OB_CACHE_MAX`, `OB_INDEX_POLL_MS`,
  `OB_TRIGRAM_SEARCH`, `OB_INDEX_PERSIST`, `OB_DISTILL_TOOLS`, …).

## 4. Follow-ups (not blocking)

- **garden/distill live validation**: exercise the hardened prompts end-to-end on
  the real vault once an `OB_SUBAGENT_MODEL` is configured (the audit subagent is
  skipped here). Manual / a separate session.
- **C5 beyond substring**: regex/words/fuzzy still full-scan by design (their
  `match` isn't a literal substring); leave as-is unless a cheap pre-filter appears.

## Conclusion

C5 and C6 are **correct on real Chinese content and a real link graph**, and now
**genuinely fast at scale** (C6 2.74× cold-start; C5 5–10× on large vaults after
the `listNotes` fix). The `.cache/` pollution default is documented and ignored
in the bundled vault.
