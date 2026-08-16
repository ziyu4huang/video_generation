---
status: closed
---
# 02 — interactive cards: answer loop + JSONL decision log

## Tasks
1. Interactive card body schema (question + fields/options/freeText) rendered
   as a form card.
2. Submit → appexec `extra.kind: "card_answer"` guard at onCommand TOP
   (same pattern as ask_user_answer).
3. Server: append `{id, cardId, ts, answers}` to `sessions/<id>/cards.jsonl`.
4. Card resolution tombstone frame (`card_done`) so replaying shells retire
   the form — same lesson as ask_user_done.
5. Tests: e2e answer path + JSONL append + tombstone replay ordering.

## Acceptance
- Answers reach the bus exactly once; JSONL grows; replayed shells show the
  answered state, not a live form.

## Result
02: interactive card body (question + text/select fields) rendered as a form card; submit sends appexec-loose card_answer (first-answer-wins Set); JSONL decision log at cardsDir/<sessionStamp>/cards.jsonl (deps.cardsDir injectable, ~/.pi/webui/sessions default); card_done tombstone retires the form live + on replay; webui 496/0.
