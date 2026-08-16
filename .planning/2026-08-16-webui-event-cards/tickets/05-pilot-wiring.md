---
status: closed
---
# 05 — v1 pilot wiring (questionnaire + archify cards) + docs/E2E

## Tasks
1. Questionnaire: ask_user ALSO emits an interactive card (attention input);
   answers keep the existing ask-user bridge AND log via the card_answer path
   (or unify — implementer documents the choice).
2. archify: webui:open/webui:present ALSO emit a readonly/viewer card with deep
   link; attention view.
3. Docs: README sections (Cards tab, bell, deep links, decision log) + archify
   README line.
4. E2E: pilot flow — questionnaire card answered, archify card opened,
   decision log grows.

## Acceptance
- Both pilots work end-to-end against a live session; replay restores both
  card kinds; gates green.

## Result
05: questionnaire prompts ALSO emit interactive ask-cards (attention input; answers ride the EXISTING ask_user_answer bridge — unify choice; JSONL stays generic-interactive-only); answered retires them via card_done (Set-guarded); archify open/present emit attention-view readonly cards with body.url (fail-closed containment); snoop de-noised (rpiv:* internal + open/present have dedicated cards; t01 tests moved to custom:event); webui 521/0.
