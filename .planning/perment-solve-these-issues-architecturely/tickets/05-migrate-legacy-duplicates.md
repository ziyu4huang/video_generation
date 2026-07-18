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
blocked by: 02
status: open
