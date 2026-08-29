---
name: session-closeout-sop
description: Use at every arc close-out (hands-off) as the command-exact runbook of the session close-out chain — push-first rule, strict-v2 next-goal file shape, validator + LATEST repoint, the devops CLI command table, and environmental-red gate discrimination. The authoritative spec is the self-reflect-next-goal skill; this is its condensed, command-exact twin.
---

# Session close-out SOP (devops chain)

The runbook behind the hands-off gate of `.claude/skills/using-s2-agent-skills`
(and the **self-reflect-next-goal** ext skill
`bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md` — the
authoritative spec; this file is the condensed, command-exact version as
vetted on the registry t03 close-out, 2026-08-24).

Goal: **no session stops without a validated successor that names the queue
head**, and no work is ever left only in the working tree.

## A. Close-out (WRITE) — at every arc boundary

0. **Push before you write.** Working tree clean; every change committed on a
   feature branch and pushed (PR opened when the arc produced reviewable
   changes — full merge via the devops chain when gates ran green). A
   successor whose head is "commit my changes" drops the carry.
1. `ts=$(date +%Y%m%d-%H%M%S)` — filename EXACTLY `next-goal-<ts>.md`.
2. Write `output/next-goal-<ts>.md` in the **strict v2 shape**: frontmatter
   keys exactly `file:` (this file's OWN absolute path) / `created:`
   (`YYYY-MM-DD HH:MM:SS` matching the filename timestamp) / `supersedes:`
   (absolute path of the `LATEST` target, or `none`); then exactly the five
   headings in order: `# Next goal — <title>`, `## Verified this session`
   (evidence only), `## Honest gaps`, `## Immediate steps`,
   `## Done when` (≥1 unchecked `- [ ]`), `## Ranked next goals` (**3–5**
   numbered entries, ranked, each with a first step — a 6th entry fails the
   validator; fold the rest into Honest gaps).
3. Validate the file: `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts output/next-goal-<ts>.md` — exit 0 or fix (never hand off an unvalidated file).
4. Retention: keep at most 10 `next-goal-*.md`; over → delete oldest by
   filename timestamp. Never delete otherwise.
5. `ln -sf next-goal-<ts>.md output/LATEST-next-goal.md` (from repo root).
6. Doctor: `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`
   (no args) — `problems: []` or fix.
7. `output/` is gitignored scratch — never commit it; durable artifacts go to
   `.planning/`.

**Queue mode** (ticket of a `.planning/<effort>/` effort): `Immediate steps`
= the effort's chosen `Execution order` head (map.md `## Tickets` line), or
the map `## Frontier` when no choice recorded; `Done when` = that ticket's
acceptance criteria; supersede the file at EVERY verified+merged ticket
boundary, even mid-session. Empty queue → head = effort close-out and the
loop ENDS.

## B. Next iteration (READ + EXECUTE)

1. **Re-read the team inbox at session start** (the #2122 pattern):
   `~/.claude-glm/teams/session-*/inboxes/team-lead.json` may hold verdicts
   from yesterday's reviewers — on claude CLI 2.1.247 child→lead injection
   was measured delayed >24h, and a late REQUEST_CHANGES landed against
   already-merged code (both blockers real → #2122). A delayed verdict is
   actionable: check it against current main before acting on stale findings.
2. Sync first: `bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts --mode rebase`
   (detached-HEAD abort is not a skip: `git fetch origin main && git
   rev-list --count HEAD..origin/main` — `0` = proceed, else create a
   branch from `origin/main` via `prepare-feature-branch-cli` before work).
3. Read `output/LATEST-next-goal.md` (the symlink). Its `Immediate steps` ARE
   the queue head — execute in-session through every `Done when` box.
4. If a step is factually impossible, surface it — don't improvise a
   different design. If `LATEST` is absent/dangling, say so and ask; never
   invent a goal while a queue holds tickets.

## C. The devops command chain (verified command forms)

| Phase | Command | Notes |
|---|---|---|
| Sync | `sync-default-branch-cli.ts --mode rebase` | aborts `detached_head` — check `HEAD..origin/main` first |
| Branch | `prepare-feature-branch-cli.ts <name> --rebase` | switches THIS worktree's branch — never mid-subagents (memory) |
| Gates | `local-ci-cli.ts` (change-scoped) | run BOTH `bun run check`-style per-package gates and `bun test`; `main-health-cli.ts` only when "is main green?" |
| Version | `version-bump-cli.ts --package s2-agent --patch` | at PR finish; commits the bump with the change it names |
| PR | `gh pr create` (title/body) | code + a separate planning/docs PR per convention |
| Merge | `merge-pr-after-ci-cli.ts <pr> --expected-scope <glob>…` | `--expected-scope` is REPEATABLE (`x/**` any depth; `x/` prefix); runs its own local-CI gate on the true head; aborts if PR not OPEN |
| Verify | `verify-merge-cli.ts <pr> --scope "<g1>,<g2>"` | `--scope` is ONE comma-separated flag (not repeatable) — misuse reports false CONTAMINATED |
| Main check | `main-health-cli.ts` | full matrix, read-only |

## D. Environmental-red discrimination (when a gate fails)

A gate can fail for operator-account reasons, not diff reasons. Discriminate
before calling it a regression (vetted 2026-08-24 — zai coding-plan quota
turned the probe's stderr-clean assertion red):

1. Reproduce on a **pre-change deployed tree** (e.g. `~/proj/dist/s2-agent-sh/current`
   built before the branch) — same failure = pre-existing.
2. Identify the actual caller: local intercept (point the base-url env at a
   one-line Bun server logging method/path/headers), or direct `curl` of the
   suspected endpoint with the env key.
3. Proof of isolation: boot with an explicit `--model <healthy-provider>` —
   clean boot = the failure is default-provider init, not the diff.
4. Then fix the gate's dependency (e.g. pin the probe suite to the deepseek
   provider — map decision D8) and record the decision, instead of chasing a
   phantom regression.
5. `--assume-ci-green <sha>` on the merge tool is a retry shortcut for a sha
   YOUR OWN gates verified — never a way to merge something local CI has not
   seen.

## E. Hard rules carried from the spec

- Evidence in `Verified this session` (PR number, CI verdict, command output);
  argued/stubbed/un-run goes in `Honest gaps`.
- Never commit `output/`; never delete next-goal files except oldest-over-10;
  never freelance the v2 shape — the validator is the arbiter.
- The user's env keys/quota states are never CI's concern: gates depend on the
  repo, operator constraints get pinned (D8-style) and documented.
