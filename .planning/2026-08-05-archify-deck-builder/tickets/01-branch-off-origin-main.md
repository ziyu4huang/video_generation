---
type: task
blocked by: []
claimed: pi-agent (branch)
status: closed
resolved: 2026-08-05
---

## Question

Set up an isolated git branch (or worktree) off `origin/main` for the archify deck-builder work, so it does **not** land on the current unrelated, 74-behind branch `feature/purify-transformer-backend-swift-native-port`.

Decide: a new branch `feature/archify-deck-builder` cut from `origin/main`, or a dedicated git worktree (consult the `using-git-worktrees` skill). Carry the uncommitted design spec (`bun-apps/pi-agent-ext-archify/docs/2026-08-03-deck-design.md`) onto it.

This is AFK-able setup that unblocks all downstream implementation. Resolved when the branch/worktree exists and the spec doc is on it; record the chosen mechanism + branch name as the answer.

## Resolution (2026-08-05)

Landed on a dedicated worktree off `origin/main` (matches the repo's one-worktree-per-feature convention):

- **Worktree:** `/Users/huangziyu/proj/video_generation__archify-deck` on new branch `feature/archify-deck-builder`, based on `origin/main` @ 31f4c967 (fetched fresh).
- **Mechanism:** a NEW worktree (not in-place) — keeps the unrelated `feature/purify-transformer-backend-swift-native-port` worktree intact. Transferred the archify deck files (scripts/, __tests__/, docs/, package.json, README, .planning); **regenerated `bun-apps/bun.lock`** on the origin/main base via `bun install` (only 4 new packages — rest reused from the global store). The 31 lines of Swift-port lockfile churn were NOT carried over.
- **Verified in the clean worktree:** `tsc --noEmit` exit 0; `bun test` 55 pass / 0 fail.
- **Committed + pushed:** `feat(archify): IR-PPTX deck builder`. **PR #1037** → `main`.

This also lands the ticket-04/05 work (previously uncommitted) onto the proper branch. Only ticket 03 (densified example) remains, and it is content, not a landing concern.
