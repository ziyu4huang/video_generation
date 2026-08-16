---
type: task
status: closed
---

# 04 — answered-card detail persistence for replay

## Question

Answered ask-cards are fully reviewable live (question + label: answer detail block), but snapshot replay degrades to the collapsed summary because answers are stashed on the article at submit-time only; persist the answered details (JSONL/snapshot) so replayed answered cards render the same read-only detail block; live unchanged; tests.

## Result
04: two root causes fixed — (1) sessionStore FIFO cap evicted early card frames (card/card_done now exempt; eviction removes non-card frames only); (2) card_done carried no answers so replay could not render review detail — tombstones now carry answers rows (card_answer map entries; ask rows mapped from QuestionnaireResult; the ANSWER guard owns the ask tombstone, answered-alone emits only ask_user_done). Shell retireCard renders review from frame.answers when the live stash is absent. webui 482/0.
