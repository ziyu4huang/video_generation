---
name: self-reflect-next-goal
description: Use when a mutating session or goal arc is closing (PR merged, deploy shipped, milestone verified, session ending) or when planning the next piece of work and deciding what to pick up — the rolling next-goal files record what shipped and what comes next.
---

# Self-Reflect + Next Goal

Every completed arc hands off a concrete next goal — a session never just stops.
The behavior lives in these files, not in any one agent's private memory: close
out by WRITING the newest next-goal file, open new work by READING it.

## When to use

- A mutating run finished: devops-workflow chain done (merge verified, branches
  swept, retrospective run), deploy shipped, or a multi-step goal reached "done".
- A session is closing with real work behind it.
- Planning the next task / starting a session: read the newest file first.

Not for: read-only Q&A, aborted runs with nothing shipped (say so honestly and
skip the file).

## WRITE (on close-out)

1. `ts=$(date +%Y%m%d-%H%M%S)` — local time, seconds precision for uniqueness.
2. Write `output/next-goal-<ts>.md` at the repo root, in English:

```markdown
# Next goal — <YYYY-MM-DD>

Shipped this session: <what landed — with the verification evidence
(PR number, CI verdict, command output), not just "done">.

## Ranked next goals

1. **<goal>** — why it matters + the concrete first step. <absolute date if
   time-bound>.
2. …
```

3. Retention: keep at most **10** `next-goal-*.md` files. Over 10 → delete the
   oldest by filename timestamp until 10 remain. Never delete otherwise.
4. `output/` is gitignored scratch — never commit these files. Durable plans
   belong in `.planning/`; this file is the session-to-session handoff.

## READ (on planning)

Read the NEWEST file only; older ones are history, never active. Carry forward
any still-open goal from the newest file into the new one you write — fold it
into the ranked list, don't silently drop it.

## Honest reflection rules

- Separate **verified** (deterministic or empirical evidence) from **argued**
  (stubbed, un-run, "should work"). Name the gaps — they seed the next goals.
- Goals are ranked and few (3–5), each specific enough to start without
  re-deriving context.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| "Shipped X" with no evidence | Cite the PR/CI/command output that proves it |
| 10 unranked wishlist items | 3–5 ranked, each with a first step |
| Deleting prior files eagerly | Rolling history, MAX 10, prune oldest only |
| Committing next-goal files | `output/` is scratch; `.planning/` is durable |
| Dropping an unfinished prior goal | Fold it into the new ranked list |
