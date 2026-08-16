---
type: task
status: open
---

# 04 — answered-card detail persistence for replay

## Question

Answered ask-cards are fully reviewable live (question + label: answer detail block), but snapshot replay degrades to the collapsed summary because answers are stashed on the article at submit-time only; persist the answered details (JSONL/snapshot) so replayed answered cards render the same read-only detail block; live unchanged; tests.
