# Deterministic edit dispatch (candidate skill)

## Trigger / symptom
Orchestrator/controller sessions must edit repo files but CANNOT edit directly (restricted tool surface); every write goes through subagent children that abort often (observed ~40 mid-flight deaths in one arc). Children asked to "apply this change" freelance: they re-derive anchors, mangle template literals, run scripts twice duplicating insertions.

## Lesson
Move ALL judgment to the controller: children become mechanical "write this file / run this script / paste output" executors. A child that only transcribes a heredoc and runs one command survives at 1-2 turns; a child that "understands" the edit dies mid-thought and leaves half-applied state. /tmp artifacts survive child deaths — the work is never lost, only the report turn.

## Proposed procedure
1. Recon FIRST via read-only "transcriber" children: `grep -n`/`sed -n` anchors, verbatim transcription, zero analysis ("run exactly this, transcribe raw output").
2. Controller authors `/tmp/apply-XX.ts` scripts: exact pair replacements with a `rep(from, to, tag)` helper printing HIT/MISS/AMBIG per tag, guarded by an ALREADY check (`if (t.includes(to))`) so re-runs are idempotent; `wr()` for new files.
3. MISS protocol: grep the fragment, adjust ONE pair, `git checkout -- <file>` to reset, re-run ONCE — never let a child "fix" a miss.
4. Double-run contamination (anchor survives inside its own replacement): fix by adjacent-duplicate collapse (`block+block -> block`) after checking counts with grep -c.
5. Template-literal files (shell JS inside backticks): authored insertions must contain NO backticks, NO backslashes, NO dollar-brace; escape sequences stay double-backslash in source.
6. Mechanical ship steps as SINGLE-command transcriber children: `git add X && git commit -m "..." && git push ... && gh pr create ... | tail -1` — the report is the command output.
7. Long gates: `bash ci-local.sh --gates > log 2>&1; echo EXIT=$?; tail -1 log` inside the same block (or nohup + poll loop when a child death mid-CI is possible).
8. Verify landed state with a 1-turn state-check child (grep -c sentinels + suite REAL pass/fail lines) before the next dispatch — never assume.

## Evidence
webui-v3 arc 2026-08-17/18: 22 PRs shipped through ~40 child aborts using exactly this shape (PRs #1572-#1604, video_generation repo); every death recovered in <=2 bounded follow-ups; zero freelanced edits. Complements subagent-dispatch-budget-protocol.md (shape vs budget).

## Candidate skill-name
deterministic-edit-dispatch

## TDD baseline (2026-08-18, promotion test 1 of 2 — RED confirmed)

Scenario: subagent, tools [read, edit, bash], task "change 'hello' to 'hi' in /tmp/baseline-target.ts; report every command verbatim".

- Run 1 (progress-log-only child): detected the target state, NO edit protocol used — wrote a progress log via printf heredoc instead.
- Run 2 (edit tool available): used read+edit+cat directly — the freelance-edit pattern, NO /tmp pair-replacement script, NO HIT/MISS/AMBIG, no git checkout reset discipline. Both runs finished the task but by luck-of-simplicity, not by protocol; nothing enforces idempotence, MISS recovery, or template-literal safety.

RED verdict: without the skill text, children do NOT apply the protocol — the candidate addresses a real behavioral gap (green test pending: same scenario with the Procedure section in-prompt must show script-based edits with ALREADY guards).

## TDD green (2026-08-18, promotion test 2 of 2 — GREEN confirmed)

Same scenario as the RED baseline (subagent, tools [read,edit,bash], 'hello'->'hi' in /tmp/baseline-target.ts), with the skill's Procedure text IN the prompt. The child:

- authored /tmp/apply-hello-to-hi.ts unprompted — a verbatim rep(from,to,tag) helper with the ALREADY idempotence guard FIRST, then occurrences==0 -> MISS, >1 -> AMBIG, else HIT+write;
- ran it via bun; re-running prints ALREADY (no MISS, so the reset step never fired — exactly per protocol);
- NEVER touched the edit tool; the script was the only mutation path;
- final file correct ('hi'), script body archived in this record's evidence.

RED (freelance read+edit, no protocol) vs GREEN (script-only, idempotent) — the candidate's Procedure demonstrably changes child behavior. Candidate READY for promotion via the writing-skills process.

Evidence: /tmp/apply-hello-to-hi.ts (verbatim in the promotion transcript); runs 2026-08-18.
