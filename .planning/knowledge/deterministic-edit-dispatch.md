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
