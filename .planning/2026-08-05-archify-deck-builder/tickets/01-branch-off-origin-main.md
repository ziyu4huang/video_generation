---
type: task
blocked by: []
claimed: pi-agent (branch)
---

## Question

Set up an isolated git branch (or worktree) off `origin/main` for the archify deck-builder work, so it does **not** land on the current unrelated, 74-behind branch `feature/purify-transformer-backend-swift-native-port`.

Decide: a new branch `feature/archify-deck-builder` cut from `origin/main`, or a dedicated git worktree (consult the `using-git-worktrees` skill). Carry the uncommitted design spec (`bun-apps/pi-agent-ext-archify/docs/2026-08-03-deck-design.md`) onto it.

This is AFK-able setup that unblocks all downstream implementation. Resolved when the branch/worktree exists and the spec doc is on it; record the chosen mechanism + branch name as the answer.
