## Question

Where do we base the migration, given this branch (`video_generation__file2md`) holds 3 unpushed superpowers commits the map ruled out-of-scope (ships separately), is 1 behind `origin/main`, and its upstream is `[gone]`?

_(Premise corrected during resolution: there is **no** divergent duplicate — see Resolution.)_

type: grilling
status: closed
claimed: agent:main-session
blocked by: _(none — informed by [02-inventory-touch-points](02-inventory-touch-points.md))_

## Notes for the resolver

Facts (corrected): the introducing commit `4fbc35b2` is an **ancestor of `origin/main`**, and `git diff origin/main HEAD -- <package>` is empty — the package is byte-identical on both lines via one shared commit. There is **no** duplicate to reconcile. The 3 commits this branch holds ahead of main are an **unrelated** superpowers `.planning` migration. Candidate strategies grilled (one question, recommended ⭐ option):

- **(a) ⭐ Fresh short-lived branch off latest `origin/main`** — do the migration there, PR it. Cleanest isolation; the unrelated superpowers commits stay on their own branch and ship separately.
- **(b) Rebase this branch onto `origin/main` first** — resolve the duplicate response-language dir, then migrate here. Keeps the 3-ahead commits but drags unrelated work into the migration PR.
- **(c) Migrate on this branch, resolve the deletion-vs-addition conflict at merge time** — simplest now, deferred conflict.

The decision turns on the user's branch-hygiene preference and whether the superpowers `.planning` commits should ship with or separately from this migration. Confirm the chosen branch base before executing ticket 05.

## Resolution

**Base the migration on a fresh branch off `origin/main`.** Chosen over migrate-here/ship-together and rebase-onto-main.

- The migration lands on a new branch created from latest `origin/main` — either a new worktree, or `git checkout -b <name> origin/main` re-pointing this worktree.
- The 3 unpushed superpowers commits stay on `video_generation__file2md` for **separate** shipping — consistent with the map's Out-of-scope stance. They are NOT carried by this migration's PR.
- No package conflict is possible (identical shared commit), so the deletion + core-task move applies cleanly on the fresh base.

**Premise correction (recorded for the map):** the original Question assumed a "divergent duplicate ... via different commits." That was false — `4fbc35b2` is on `origin/main` and the package is byte-identical. [02-inventory-touch-points](02-inventory-touch-points.md)'s duplicate note and the map's index line are corrected accordingly.

Ticket 05's first acceptance criterion now reads concretely: **create a fresh branch off `origin/main`** before doing the move.
