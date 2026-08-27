---
name: self-reflect-next-goal
description: Use when a mutating session or goal arc is closing (PR merged, deploy shipped, milestone verified, session ending), when planning the next piece of work, when a ticket queue of a `.planning/<effort>/` effort needs its next head carried (queue mode), or when the user triggers "hands on (next goal)" — execute the rolling next-goal file's Immediate steps end-to-end through its done-when gate.
---

# Self-Reflect + Next Goal

Every completed arc hands off a concrete next goal — a session never just stops.
The behavior lives in these files, not in any one agent's private memory: close
out by WRITING the newest next-goal file, open new work by READING it.

## The strict format (v2 — machine-checked)

The handoff is a contract between sessions, so it has ONE fixed shape and a
validator that enforces it
(`bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`, logic in
`src/validate-next-goal.ts`, pinned by `tests/validate-next-goal.test.ts`).
Prose templates drifted before (the v1 template said "Shipped this session";
files said "Why this goal") and nothing caught it — do not freelance sections,
headings, or frontmatter keys.

```markdown
---
file: /ABS/PATH/TO/REPO/output/next-goal-YYYYMMDD-HHMMSS.md
created: YYYY-MM-DD HH:MM:SS
supersedes: /ABS/PATH/TO/REPO/output/next-goal-<previous-ts>.md
---

# Next goal — <one-line title>

## Verified this session

<What landed, with the verification evidence (PR number, CI verdict, command
output) — verified means evidence, not "done". Anything argued/un-run belongs
in Honest gaps.>

## Honest gaps

<What is still open, stubbed, or unmeasured. These seed the ranked list —
an empty gaps section is a red flag, not an achievement.>

## Immediate steps

<The CURRENT goal: ordered, concrete, actionable steps the executor runs
in order. Branch prep via the devops chain, implementation, gates, review,
close-out — exactly as written. EVERY step explains in detail WHAT the next
session will do — the concrete action, the files/packages it touches, the
approach, and the gates — so the executor never re-derives context: a bare
pointer ("1. Fix it.") fails the validator's `immediate-steps-detail`
check (≥1 numbered step, each ≥80 chars with wrapped lines joined). A
wait-state step states in full WHAT it waits for and HOW the next goal
derives.>

## Done when

- [ ] <checkbox gate — every box must be checkable with evidence>
- [ ] …

## Ranked next goals

1. **<goal>** — why it matters + the concrete first step.
2. …
3. … (3–5 entries, ranked; the head becomes the next file's Immediate steps)
```

Frontmatter rules (strict — exact key set, no extras):

- `file:` — the **absolute path of this very file**. Not relative, not the
  symlink, not the predecessor. `output/` is per-worktree gitignored scratch:
  when sessions run in several worktrees, this field is the ONLY thing that
  names which tree's handoff you are holding. The validator fails a file whose
  `file:` does not resolve to itself.
- `created:` — `YYYY-MM-DD HH:MM:SS` (local), must equal the filename's
  date AND time parts. Date-only is NOT enough — sessions write several
  handoffs on the same day, and the date alone cannot order them.
- `supersedes:` — the **absolute path** of the predecessor file, or `none`
  (only for the first file ever written). A pruned predecessor is a warning,
  not a failure.

Section rules: the five `##` headings above, EXACT spelling, EXACT order.
`Immediate steps` needs ≥1 numbered step, each detailed enough that the next
session knows WHAT it will do without re-deriving context (≥80 chars with
wrapped lines joined — the `immediate-steps-detail` check). `Done when` needs
≥1 unchecked `- [ ]` box (all-checked = a closed record — write the successor
instead). `Ranked next goals` needs 3–5 numbered entries.

### Focus scope (ranked-list discipline)

The 3–5 ranked entries are a FOCUS queue, not a general backlog. A successor
that pads its ranked list with goals outside the active focus scope turns the
next "hands on" into a diversion — the executor dutifully executes the head,
and the head is off-mission work. Rules:

- **The successor inherits the predecessor's focus scope** unless the user
  re-scopes it (e.g. names an extension family, effort, or package set). State
  the scope as one line under the title (e.g. `Focus: hermes-memory /
  knowledge-card / obsidian / file2md`) so the next reader sees the fence.
- **Every ranked entry must be in scope.** Pad toward the 3-entry minimum with
  in-scope dormant items — trigger-gated re-checks, measured-receipt gaps,
  standing flakes inside the scope — not with out-of-scope goals.
- **Out-of-scope items appear ONLY when they block in-scope work** (e.g. a
  broken reviewer pool blocks every code ticket's D14 gate), and the entry
  says it blocks what.
- **When the in-scope queue is truly empty**, the successor's head is an
  explicit wait-state ("awaiting <trigger>") — never an invented out-of-scope
  goal. The loop's purpose ends with its scope; other work gets its own
  effort, not a smuggled ranked entry.

## WRITE (on close-out)

0. **Push before you write.** A hands-off NEVER leaves uncommitted or
   unpushed work behind — the successor's Immediate steps must never be "commit
   my changes" (that is exactly the carry a close-out silently drops when the
   tree is swept or a sibling session clobbers it). Before writing the file:
   the working tree is clean, and every change this session made is committed
   on a feature branch and PUSHED to origin (PR opened when the arc produced
   reviewable changes — full merge via the devops chain if its gates already
   ran green). If a gate blocks the push, surface that blocker to the user and
   stop — do not write a successor that defers the push. The only acceptable
   unpushed state is a deliberately work-in-progress WIP branch the user asked
   to park, and then the successor's `## Honest gaps` names it by branch.
1. `ts=$(date +%Y%m%d-%H%M%S)` — local time, seconds precision for uniqueness.
   The filename pattern is EXACTLY `next-goal-YYYYMMDD-HHMMSS.md` — no
   underscores, no ISO `T`/timezone suffixes, no fabricated timestamps. It is
   the sort key for newest-file resolution and pruning.
2. Write `output/next-goal-<ts>.md` at the repo root, in English, in the
   strict v2 shape above. Build the frontmatter from REAL values:
   `file: $(pwd)/output/next-goal-<ts>.md`, `created:` from the SAME `ts`
   (e.g. `20260823-022001` → `2026-08-23 02:20:01` — date AND time),
   `supersedes: $(readlink
   output/LATEST-next-goal.md | sed "s|^|$(pwd)/output/|")` (or `none`).
   Then REREAD `## Immediate steps` as the next session would: does each
   step say exactly WHAT will be done — action, files/packages, approach,
   gates? A step that only names a goal without saying how it will be
   executed is not done; expand it before validating. The same detail goes
   into your closing REPORT: when you report the arc done, tell the user
   in plain terms what the next session is going to do.
3. Validate BEFORE pointing the symlink:
   `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts
   output/next-goal-<ts>.md` — exit 0 or FIX THE FILE; never ship a file the
   validator rejects.
4. Retention: keep at most **10** `next-goal-YYYYMMDD-HHMMSS.md` files. Over
   10 → delete the oldest by filename timestamp until 10 remain. Never delete
   otherwise. `LATEST-next-goal.md` does NOT count toward the 10 and is never
   pruned.
5. Repoint the pointer: `ln -sf next-goal-<ts>.md output/LATEST-next-goal.md`
   (relative target, run from the repo root).
6. Final check — the doctor (no args = nearest repo root's `output/`):
   `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts` — must
   exit 0 (LATEST resolves to the newest file, target validates, retention
   within cap).
7. `output/` is gitignored scratch — never commit these files. Durable plans
   belong in `.planning/`; this file is the session-to-session handoff.

### Ticket-queue mode (effort ticket queues)

When the goal is a ticket of a `.planning/<effort>/` queue, the file is the loop's carry and
the fixed shape gets queue semantics:

- `Immediate steps` = the **next ticket** in the effort's chosen `Execution order` (the
  `**Execution order:**` line under `map.md` `## Tickets`); when no choice was recorded, the
  ticket the map's `## Frontier` names.
- `Done when` = that **ticket's acceptance criteria** (evidence-checkable), not goal prose.
- `Ranked next goals` = the remaining queue in the chosen order, then the effort close-out
  (map status: complete), then any fold-back/audit items — still 3–5 entries, even when the
  queue alone has fewer (the close-out + carry-over items pad it).
- **Boundary discipline:** after ANY verified + merged ticket in a multi-ticket effort,
  supersede the file even mid-session — `LATEST-next-goal.md` must always name the queue head,
  never yesterday's ticket.
- **Termination:** when the queue is empty, the successor's head = the effort close-out; the
  loop ENDS there. Never write a self-perpetuating goal — an all-done queue is a closed
  record, not the seed of new work.
- **Overridden blockers:** if the user chose an order that contradicts a ticket's `blocking:`
  edge, keep the choice but flag the dependency in `Honest gaps` — don't silently break the
  queue.

## READ (on planning)

Read `output/LATEST-next-goal.md` — the stable pointer to the newest file. If
the symlink is missing, fall back to the newest `next-goal-YYYYMMDD-HHMMSS.md`
by filename timestamp. Older files are history, never active. Carry forward
any still-open goal from the newest file into the new one you write — fold it
into the ranked list, don't silently drop it. Mind the `file:` field: if its
absolute path is a DIFFERENT worktree than yours, you are reading another
tree's handoff — sync or re-derive before executing it.

**Queue drift rule:** when the file's `Ranked next goals` mirrors a ticket queue, the ranking
must match the effort's user-chosen `Execution order` line (`## Tickets` in
`.planning/<effort>/map.md`) — on disagreement, surface the drift (present both, ask which
governs) rather than silently picking one.

## EXECUTE ("hands on next goal")

The user's trigger phrase **"hands on next goal"** (or plain "hands on") means:
execute the head of the queue end-to-end, this session — not just plan it.
It starts from a synced tree, not whatever HEAD happens to be lying around.

1. **Sync to the remote default branch first, rebase style**: `bun
   bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts --mode rebase`.
   The queue head was written against main as of its session; main moves under
   you between sessions. In a detached-HEAD worktree the CLI aborts
   (`reason: "detached_head"` — it refuses to rebase a detached tree); that is
   not a failure to skip: fetch and compare (`git fetch origin main && git
   rev-list --count HEAD..origin/main`) — `0` means you are already at the tip
   and may proceed, anything else means create/switch a branch from
   `origin/main` via `prepare-feature-branch-cli` before executing.
2. Read `output/LATEST-next-goal.md` (the symlink; fall back to the newest
   `next-goal-*.md` if it is missing). If the file says decisions are
   pre-approved / "do not re-litigate", honor that — execute, don't re-decide.
3. Carry out its **Immediate steps** in order: branch prep via the devops
   chain, implementation, tests, canonical gates — exactly as written unless a
   step is factually impossible (then surface the blocker, don't improvise a
   different design).
4. Stop only when every box in **Done when** is checked. Report honestly which
   boxes are verified vs still open.
5. Close out per the file's own instructions (usually: reviewer pass, PR via
   the devops chain, ticket/map close-out), then WRITE the successor file
   (strict v2, validated) and re-point the `LATEST-next-goal.md` symlink at it.

**Ticket-queue heads** (Immediate steps naming a ticket of an effort queue): after the gate
step, execute the head end-to-end through its Done-when gate, then per WRITE's boundary
discipline write the successor headed at the next ticket — and either continue in-session
while the session is still fresh or stop at the boundary (the successor is the next "hands
on"). The loop repeats; it STOPS when the successor's head is the effort close-out (queue
drained). The effort's chosen `Execution order` (map.md line) is the authority for what "next"
means, not the file's own wording — drift gets surfaced (READ's drift rule), never silently
picked.

Not for: a "hands on" that names a DIFFERENT artifact (read what it points at
instead). If `LATEST-next-goal.md` is absent or dangling, say so and ask before
picking a goal yourself.

## LATEST symlink

`output/LATEST-next-goal.md` → the newest `next-goal-<ts>.md`. Re-point it
(`ln -sf`) every time a new file is written — EXECUTE reads the symlink, so a
stale pointer executes the wrong goal. The symlink lives in gitignored
`output/`; it is a per-machine convenience, never committed.

## Honest reflection rules

- Separate **verified** (deterministic or empirical evidence) from **argued**
  (stubbed, un-run, "should work") — that split is now the section structure:
  evidence lives in `## Verified this session`, caveats in `## Honest gaps`.
- Goals are ranked and few (3–5), each specific enough to start without
  re-deriving context.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| "Shipped X" with no evidence | Cite the PR/CI/command output that proves it |
| Bare-pointer Immediate steps ("1. Fix it.") — successor names the goal but not how it will be executed | Every step details action + files/packages + approach + gates (validator `immediate-steps-detail`, ≥80 chars); the closing REPORT tells the user what the next session will do |
| Freelanced sections/headings/frontmatter keys | The five headings + three keys are exact; the validator is the arbiter |
| Relative or wrong `file:` path | Must be this file's OWN absolute path — it names the owning worktree |
| 10 unranked wishlist items | 3–5 ranked, each with a first step |
| Deleting prior files eagerly | Rolling history, MAX 10, prune oldest only |
| Committing next-goal files | `output/` is scratch; `.planning/` is durable |
| Dropping an unfinished prior goal | Fold it into the new ranked list |
| Off-pattern filename (`_` separator, ISO timestamp, made-up time) | Only `next-goal-YYYYMMDD-HHMMSS.md` from real `date` output sorts correctly |
| Date-only `created:` | Must carry the time too — `YYYY-MM-DD HH:MM:SS` from the same `ts` as the filename; the date alone cannot order same-day handoffs |
| Writing the file but not repointing `LATEST-next-goal.md` | Step 5 of WRITE — a stale pointer hands the next session the WRONG goal |
| Hands-off with uncommitted/unpushed work ("the successor will commit it") | Step 0 of WRITE — push FIRST; a successor whose head is "commit my changes" drops the carry the moment the tree is swept |
| Skipping the validator/doctor | Steps 3 and 6 of WRITE — exit 0 or fix; never hand off an unvalidated file |
| "Hands on" treated as "plan the goal" | It means EXECUTE through the done-when gate |
| Executing the queue head from a stale tree | Step 1: sync-default-branch-cli `--mode rebase` first; detached HEAD → verify `HEAD..origin/main` is 0 before proceeding |
| New session invents a fresh goal when a queue head exists | Boundary discipline: the successor's `Immediate steps` name the NEXT ticket of the effort's chosen `Execution order` — never an unlinked goal while the queue holds tickets |
| The loop never ends (every successor invents new work) | Queue-drain termination: empty queue → successor head = effort close-out (map status: complete), the loop STOPS |
| Padding the ranked list with out-of-scope goals | Focus-scope rule above: rank in-scope only; dormant re-checks pad the minimum; out-of-scope only when it BLOCKS in-scope work |
