status: open

# 01 — answer round-trip + reviewable answered cards

Bug facts (verified 2026-08-16): render-shell.ts has TWO ask_user_answer senders — L515 (ask CARD, t05) sends result:{cancelled:false, answers:[{questionIndex,question,kind,answer}]} (matches QuestionnaireResult); L737 (ask dialog) sends result:{answers:<map>}. Wiring L594 forwards verbatim to rpiv:ask-user:answer; task-side ask-user-question.ts L139 doneRef resolves p.result -> buildQuestionnaireResponse. User observed: dialog retires + answer echoed (appendix) BUT the tool result the orchestrator sees is `undefined`.

Steps:
1. REPRO TEST FIRST (task-side, mirror external-answer.test.ts): emit prompt, then answer via the EXACT L515 payload; assert execute() resolves with the answers (not undefined/cancelled). Then via L737 map shape; assert the same. Whichever shape breaks IS the bug — fix the sender (or the consumer mapping) minimally; card path is canonical.
2. Find the "appendix" echo: grep where a resolved questionnaire result is appended to the transcript/webui frames (ask_user frame? tool result echo? tui transcript appender?). Kill the DUPLICATION only — the card itself becomes the review surface.
3. Reviewable answered cards (render-shell): when card_done retires an ask/interactive card, replace the form with a COLLAPSED summary (title + answered marker); click toggles a read-only details block showing question + each field label: answer (textContent only). Works live + snapshot replay. No innerHTML additions if avoidable (count must stay <= 8).
4. Gates: typecheck clean; bun test 0 fail (REAL lines, report count); innerHTML <= 8.
Acceptance: repro test proves the round-trip returns answers; answered card reviewable; no duplicate answer echo; gates green.
