# 06 — Sync source duality: Claude plugin cache vs git origin

---
type: grilling
blocked by:
status: closed
claimed: pi-session (2026-07-21)
---

## Question

`scripts/update-superpowers.sh` syncs `skills/` from the **Claude plugin cache**
(`~/.claude-glm/plugins/cache/claude-plugins-official/superpowers/<ver>`),
then re-applies path forks via `apply-patches.sh`. But the upstream **git
origin** is `obra/superpowers`, checked out at `../superpowers/`. So there are
two potential sources of "upstream": the plugin cache (a release artifact) and
the git repo (the live source).

Is the duality a drift risk (plugin-cache version ≠ git HEAD; the fidelity
tests pin against fixtures copied from `skills/`, not against either source
directly), or is it fine (the plugin cache *is* the canonical release, git is
reference-only)? Decide:

- **Leave as-is, document the relationship** — the cache is canonical; add a
  one-line comment / note so no one treats `../superpowers/` as the sync source.
- **Unify to git** — sync from `../superpowers/` directly, retire the
  plugin-cache path.
- **Leave as-is, no action** — it works; the fidelity tests catch drift.

Recommend documenting the relationship (cheap, prevents a future "why are these
two things different?" confusion) unless the user wants git as the single source.

## Resolution

**Keep the plugin cache as the canonical sync source; document the
relationship.** The two upstream copies serve different purposes and are NOT
both sync sources: `~/.claude-glm/plugins/cache/.../<ver>` is the blessed
release artifact `update-superpowers.sh` syncs from (matches what Claude Code
users receive); `../superpowers/` is a local reference clone for reading
upstream (as used by ticket 01), never a sync source. The fidelity tests
(`skills-fidelity.test.ts` + `UPSTREAM.ref`) pin against fixtures copied from
`skills/`, catching drift regardless of source. Execution: add a clarifying
comment to `update-superpowers.sh` + a note in the package README that
`../superpowers/` is reference-only — folds into the downstream execution
effort.
