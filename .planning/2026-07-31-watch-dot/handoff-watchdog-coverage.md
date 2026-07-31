# Implementation handoff: Watchdog coverage batch

**Effort**: `2026-07-31-watch-dot`
**Status**: planning complete (map done, frontier empty, merged in #968);
implementation is handoff (wayfinder decides, it does not build).
**Scope**: `bun-apps/pi-agent-ext-subagent` (`src/watchdog/`).
**Complementary to**: the sibling *hardening* batch
(`../2026-07-31-let-s-continue-to-improve-base-on-known-upstream/handoff-watchdog-hardening.md`,
tickets 06/08/09) — that batch fixes the gate's **visibility / scope / singleton**;
this batch fixes its **coverage** (languages, lint sources, diff completeness).

Four **DO** decisions form a cohesive "watchdog coverage" batch. **This note is an
index + sequencing guide — the authoritative specs and acceptance criteria live in
the linked tickets** (don't duplicate here).

## The four decisions

| # | Ticket | One-line | Primary files |
|---|--------|----------|---------------|
| 02 | [Python L1 coverage](tickets/02-grill-python-l1-coverage.md) | generalize L1 into a multi-provider LSP **registry**, add **pyright** | `watchdog/lsp-diagnostics.ts` (+ new provider module), `watchdog/watchdog.ts` (L1 dispatch) |
| 03 | [Biome L1 lint](tickets/03-grill-biome-l1-lint.md) | biome as a **CLI-lint lane** (not an LSP entry), severity by domain | new `watchdog/biome-lint.ts`, `watchdog/watchdog.ts`, `watchdog/types.ts` |
| 04 | [L2 large-diff curation](tickets/04-grill-l2-diff-curation.md) | per-file-budget curation + conservative noise filter + mandatory `truncated` flag | `watchdog/repo-diff.ts` (`diffTextForReview`), `watchdog/types.ts`, `watchdog/watchdog.ts` (`summarize`) |
| 05 | [L2 input file set](tickets/05-grill-l2-input-file-set.md) | L2 = **all changed paths** (drop the TS/JS-only ternary) | `watchdog/watchdog.ts` (L71 one-liner) |

**Together they close the watchdog's coverage gaps**: 02 = L1 can see Python (this
repo's ML pipeline is currently silently unreviewed); 03 = L1 also catches TS/JS lint
tsserver misses (unused/cruft — tsconfig has no `noUnusedLocals`); 05 = L2 sees *all*
code changes (not just TS/JS); 04 = L2 never silently reviews a raggedly-truncated
diff. **審得到 → 審得全 → 審得完整**.

## Suggested implementation order

1. **PR 1 — 04 + 05 (L2 side).** Both touch L2's diff path (`repo-diff.ts`
   `diffTextForReview` + `watchdog.ts` L2 call + `types.ts`). 05 is a one-line ternary
   drop; 04 is the curation rewrite + truncation flag. Cohesive, smallest, **no
   prerequisite**. Land first. (They **must** be implemented together — 05 makes
   docs/config reach L2; 04's noise filter is what controls that.)
2. **PR 2 — 02 (L1 multi-provider registry + pyright).** L1-side, largest. **⚠
   prerequisite**: verify pyright's venv/extraPaths resolves `python/venv` +
   sibling-fork deps (`../mflux`, `../ltx-2-mlx`) — see ticket 02 + research 01.
   Standalone.
3. **PR 3 — 03 (biome CLI-lint lane).** Follows PR 2 (reuses the L1 two-lane dispatch
   02 establishes). Could standalone; cleaner after 02.

## Cross-cutting notes

- **L1 is TWO lanes** (02 framed it as one registry; 03 revealed a second): (i) the
  LSP-provider registry (`tsserver`, `pyright` — JSON-RPC via the existing
  `JsonRpcLspClient`), (ii) a CLI-lint lane (`biome lint --reporter=json`, no LSP
  plumbing). L1 dispatch = run all LSP providers **+** run all CLI-lint passes, merge
  all findings. The 02/03 implementers coordinate on this two-lane shape.
- **04 ↔ 05 coupling**: 05 broadens L2's input to all changed paths; 04's conservative
  noise filter (lockfiles + generated artifacts; **KEEP** vendored-source — this repo
  edits vendor files via `vendor_patches.py`) decides what's dropped. If docs/config
  (`.md`/`.json`/`.yaml`/`.toml`) waste budget, **expand 04's noise filter** (deny-list
  — preferred over a positive code-ext set; future-proof for new languages). Decide at
  PR-1 impl time.
- **Sibling-batch file overlap**: 04 modifies `repo-diff.ts` (`diffTextForReview`);
  sibling 08 also modifies `repo-diff.ts` (`RepoBaseline` per-file hashes). If both
  batches are in flight, sequence/coordinate — whichever lands first, the other
  rebases. No logical conflict (different functions in the same file).
- **Hermeticity** (repo value):
  - 04's curation tests use the injected `RepoGitOps` seam (no host `git`).
  - 03's biome tests inject/mock the biome binary resolver + CLI — **do not** spawn
    real `biome` in unit tests.
  - 02's pyright tests inject the provider resolver + mock the LSP client — **do not**
    spawn real `pyright-langserver`.
- **01 is framework-level** (web_search was down all session) — every Python-LSP fact
  in 02 carries "verify before impl"; the **pyright-venv prerequisite is the
  load-bearing one** (if pyright can't resolve `python/venv` + sibling forks, revisit
  ticket 02 before landing PR 2).
- **Don't "fix" `changedTsJsPaths(_before, after)`** — `_before` is intentionally
  ignored (underscore prefix); sibling 08 already grappled with this. 05 only touches
  L2's input; **L1 keeps `tsJs`** (language-specific, 02's registry concern).
- **Non-breaking**: 05 broadens L2 input (additive); 04 only changes behavior for
  >200K diffs (small diffs unchanged — acceptance (a)); 02/03 add L1 coverage. None
  break existing clean-tree watchdog tests.

## Source of truth

- Tickets: [02](tickets/02-grill-python-l1-coverage.md) ·
  [03](tickets/03-grill-biome-l1-lint.md) ·
  [04](tickets/04-grill-l2-diff-curation.md) ·
  [05](tickets/05-grill-l2-input-file-set.md)
- [map.md](map.md) — Decisions-so-far (all 5 closed; frontier empty; map complete)
- Sibling: `../2026-07-31-let-s-continue-to-improve-base-on-known-upstream/handoff-watchdog-hardening.md`
  (06/08/09 — visibility/scope/singleton)
