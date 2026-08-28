# Spec — reviewer harvest (reviewer gate as first-class tooling)

Effort: 2026-08-29-reviewer-harvest · Anchored 2026-08-29 via grill-me-with-docs
(user decisions D1–D3 below; s2-agent-ext-subagent + s2-agent-ext-ultracode
families, per user re-scope away from the parked win32 effort).

## Problem Statement

Every code ticket's independent-reviewer gate is broken in practice: the
reviewer subagent DOES complete its review (evidence: on-disk transcripts
show correct verdicts, SendMessage receipts succeed), but the verdict never
— or hours late — reaches the lead session, because the stock claude binary
(2.1.247) fails to inject child→lead inbox messages into the lead's turns.
The validated workaround (dispatch with a name, poll the subagent
transcript on disk, harvest the verdict, cite the path as the receipt) is
currently tribal knowledge in an agent memory note — sessions that don't
know it either wait ~12 min for a reply that never comes, or skip the
independent review entirely and fall back to self-review.

## Solution

The reviewer gate is first-class repo tooling: any session (claude-code or
s2-agent) dispatches a reviewer subagent and runs one repo-owned command to
poll the transcript, extract the verdict, write a durable receipt file, and
report — with the workflow docs (devops-workflow review phase, skills
routing gates) pointing at it as THE way to close the review gate. A
step-0 probe re-measures whether a newer claude CLI fixed injection; if it
has, notifications revert to primary and the tool remains the durable
fallback + receipt writer.

## User Stories

1. As a lead session, I want one command that harvests my dispatched
   reviewer's verdict from its transcript, so that I never wait on an
   injection that may not fire.
2. As a lead session, I want the harvest written as a receipt file I can
   cite in a PR body, so that "independent review" is evidenced, not
   asserted.
3. As a fresh session that knows nothing of the RCA, I want the
   devops-workflow review phase to TELL me to dispatch-with-name + harvest,
   so the discipline survives memory turnover.
4. As the repo owner, I want a recorded probe receipt of whether current
   claude CLI injection works, so the notifications-vs-harvest choice is
   evidence-based and re-checkable.
5. As a session opener, I want a prompt to re-read the team inbox at
   session start, so that yesterday's delayed verdicts surface against
   already-merged code (the #2122 pattern).

## Implementation Decisions

- **D1 (grill, 2026-08-29, user)**: anchor = reviewer-gate fix, shape =
  probe + SOP productization (the injection bug itself is harness-side —
  stock claude binary 2.1.247; no repo fix exists for it, per the closed
  RCA 2026-08-28).
- **D2 (grill, 2026-08-29, user)**: the probe runs FIRST (cheap: 3-line
  task subagent, watch for notification arrival + delay); its receipt
  decides primary mode — notifications-revert (if fixed) vs
  harvest-primary (if not). The harvest tool is built either way (fallback
  + receipt writer).
- **D3 (grill, 2026-08-29, user)**: scope = s2-agent-ext-subagent +
  s2-agent-ext-ultracode families. Ultracode verification lanes (/loop
  resume pty, 900s-FAIL recurrence) stay ranked-dormant in the queue, not
  tickets of this effort.
- The harvest tool is a devops-style headless CLI + runnable script pair
  (repo SOP: top-level `scripts/*.ts` entries are runnable; libraries in
  `src/`): input is the reviewer's dispatched NAME (+ optional harness
  root), it locates the newest matching subagent transcript under the
  claude projects dir (parameterized `~/.claude-glm` vs `~/.claude`),
  extracts the last assistant text as the verdict, writes a receipt file
  (transcript path + verdict + timestamps) under the session's output
  area, and prints JSON (throw-free, exit 0/1/2 — house CLI contract).
- Dispatch itself stays with the session's Agent tool (a CLI cannot create
  harness subagents); the tool owns everything AFTER dispatch: poll,
  harvest, receipt, report.
- Workflow wiring is docs-as-code: devops-workflow SKILL.md review phase +
  the using-s2-agent-skills route gates name the harvest command; the
  session-closeout SOP gains the inbox re-read prompt. CONTEXT.md gains
  the glossary terms (Reviewer harvest, Lead inbox injection).

## Testing Decisions

- The transcript walker + verdict extractor are pure over fixture
  transcripts (real shapes copied from the RCA evidence: thinking blocks,
  tool trail, last assistant text): unit tests pin newest-transcript
  selection, name matching, verdict extraction, and the no-match/frozen
  states (still-running vs absent).
- The receipt writer is tested against a temp output dir (path, contents,
  idempotence).
- The probe (t01) is a live receipt, not a unit test — its artifact IS the
  measurement.
- Gates: owning package's canonical `bun run test` + devops `local_ci`
  (≤5 min); scripts-dir contract test covers any new top-level script.

## Out of Scope

- Fixing the claude binary's injection (harness-side; upstream, not repo).
- s2-agent TUI-side child→parent message bus changes (no measured failure
  there today — parked as fog).
- Ultracode /loop resume lane + pty 900s-FAIL recurrence (ranked-dormant,
  per D3).
- The parked win32-launcher-stdout effort (owned by the deploy worktree
  as of 2026-08-29).

## Further Notes

- Evidence chain lives in the closed RCA (2026-08-28): probe dispatch
  completed correctly in 31s with SendMessage `success:true`, zero lead
  injection; reviewer-strip's REQUEST_CHANGES finished 30s after a nudge
  yet the parent TaskStop'd it blind; 24 unread finder messages sat in a
  team inbox; #2122 was born from a 24h-late verdict against merged code.
- The SOP's first production use (PR #2112, reviewer-addendum, APPROVE
  with 5 fact-checks harvested at 75s+60s polls) validated the mechanics
  this tool productizes.
