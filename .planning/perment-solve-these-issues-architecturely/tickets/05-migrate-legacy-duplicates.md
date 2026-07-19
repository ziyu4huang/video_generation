# 05 — Migrate the pre-existing duplicate cards

## Question

Pre-ADR-0001 / pre-wiki-aware parallel cards — including the non-deterministic
`pi-memory:<target>-<ts>-<rand>` cards from the transfer path — still litter
the vault. **How do we collapse the EXISTING graph to match the post-collapse
invariant** so the destination's "no duplicates" holds retroactively, not just
for future writes?

### Candidates

- **(a) Wiki-aware merge.** One-shot migration via the existing Jaccard ≥ 0.85
  wikiAware upsert path (`zk-query --merge-duplicates --fix` if it exists, else
  a new script) — same matcher ingest uses.
- **(b) Supersede, don't merge.** Mark the legacy `pi-memory:*` cards
  `status:superseded` (the distill pipeline's mechanism B) leaving the
  `hermes:<slug>` card as the single active one — lower-risk, reversible.
- **(c) Delete-and-reconverge.** Blow away the convergence folder, re-run
  `convergeHermesMemory` + `zk_ingest` over all sources — cleanest but
  destroys any hand-edited cards / cross-links not reproducible from source.

### Decide

- The dedup bar: 0.85 (merge related) vs 0.9 (merge near-duplicates only)?
- One-shot vs an ongoing guard (so dupes can't re-accumulate)?
- Safe to run from a dev worktree? (Interacts with T04 — must target the
  primary worktree's initialized vault, not a disconnected one.)
- Does `zk-query --merge-duplicates --fix` actually exist today, or is it the
  "optional follow-up" the 2026-07-11 memory flagged as unwritten?

type: grilling
claimed: wayfinder-session
blocked by: 02
status: closed

## Resolution (closed this session)

**Merge via existing `mergeDuplicates`, dry-run-gated at 0.9.**

**Decision 1 — approach: MERGE** via the existing `zk-query --merge-duplicates
[--fix]` → `mergeDuplicates` (`src/merge.ts`). Corrects a stale memory entry
("the tool was unwritten" — it's actually built, tested, and used by
`memory-to-vault`). Merge is **conservative + reversible**: the loser moves to
`<folder>/_archive/`, is marked `status:superseded` + `superseded_by`, its
`相關：[[...]]` links union into the canonical card, every inbound `[[loser]]`
rewrites to `[[canonical]]`, and both titles record as aliases. Canonical =
card with more inbound graph weight (tie-break: confidence, then lex-smaller
id). Chosen over supersede-only (leaves ~116 dead cards as clutter) and
delete-reconverge (destructive across 1883 cards; loses hand-edited /
non-reproducible cards).

**Decision 2 — threshold/process:** dry-run at the default **0.9** (whole-
folder — the tool has no namespace filter), REVIEW the proposed pair list
(focus on legacy `pi-memory:*` ↔ `hermes:*`), then `--fix`. If the review
shows true cross-namespace dupes falling below 0.9 (tokenization drift between
the old `entryToRecord` adapter and `adaptHermesMarkdown`), run a second
targeted pass at 0.85. "Measure first."

**One-shot + recurring guard:** the migration is a one-shot NOW (clears the
~116 legacy `pi-memory:*` cards + any other pre-wiki-aware dupes); going
forward, T02's unified path prevents new dupes at the source, and
`mergeDuplicates` becomes a periodic health check in T07's enforcement
surface.

**Build includes (run from the PRIMARY worktree per T04):**
- `zk-query --merge-duplicates` (dry-run) → review the pair list.
- `zk-query --merge-duplicates --fix` at 0.9 → apply; targeted 0.85 pass if
  the review warrants.
- Commit the vault-submodule diff (losers moved to `_archive/`) + bump the
  parent submodule pointer.
- **Flag for T07/build:** `coverageReport` (T03) must EXCLUDE `_archive/` from
  the active set so superseded losers don't count as active/sourceOrphaned.

**No new tickets; no fog graduation.** The remaining fog ("does `zk_ask` need
change once the vault is clean?") becomes verifiable only AFTER this migration
actually runs — it stays in *Not yet specified* until then.
