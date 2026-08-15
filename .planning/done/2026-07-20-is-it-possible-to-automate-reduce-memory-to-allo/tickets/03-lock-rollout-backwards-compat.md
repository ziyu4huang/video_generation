type: grilling
status: closed (2026-07-20)
claimed: charting-session
blocked by: 01 (Lock architecture survey) — resolved

## Question

How do we roll out the cross-process lock given that an advisory lock only protects once **every** `.md` writer honors it?

- **(A) Big-bang.** Build the lock into `MemoryStore` + `dedup.sh` in one PR; rebuild the extension; restart **all** live sessions so every writer is on the new code. Lock is fully active immediately. Pro: clean guarantee from the first post-deploy write. Con: a brief window where you must restart sessions; any forgotten live session (old code) races the new ones until it restarts.
- **(B) Graceful / opt-in.** Ship the lock; old sessions keep working (lock is best-effort); guarantee only firms up as sessions naturally roll over. Pro: no forced restart. Con: a silent period of partial protection — easy to *think* dedup is safe-while-live when an old session is still racing it.

**Context (from ticket 01):** this is a single-user box; all ~18 worktrees pull the same extension from one repo; there is no external/long-lived writer. So a big-bang rollout is cheap here — `scripts/sync-repo.sh`/rebuild + restart the handful of active sessions.

**Recommend (A) big-bang.** The cost (restart a few sessions) is trivial on this setup, and it's the only option that delivers the destination guarantee without a "is it actually protecting yet?" guessing game. (B)'s partial-protection window is exactly the kind of footgun the destination is meant to eliminate.

## Resolution

**Resolved (A) — big-bang.** Ship the lock in `MemoryStore` + `dedup.sh` in one PR; rebuild the extension; restart all live sessions so every writer honors the lock from the first post-deploy write. No graceful/opt-in mode.

Rationale: single-user box, all worktrees pull one extension — the big-bang cost (restart a few sessions) is trivial next to the guessing-game footgun of (B)'s partial-protection window ("is dedup actually safe-while-live yet?").

Build implication (hand-off): the lock PR is a single atomic deploy + session-restart; no feature-flag / compat-shim needed.
