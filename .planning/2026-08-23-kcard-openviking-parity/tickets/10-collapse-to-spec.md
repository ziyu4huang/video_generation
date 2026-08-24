# 10 — collapse map to spec

type: task
blocked by: 04, 05, 06, 07, 08, 09

## Question

The wayfinder hand-off: once tickets 01–09 are closed, collapse the linked decisions into a buildable plan via the `to-spec` skill (`.planning/<effort>/spec.md`), then `to-tickets` for tracer-bullet build tickets. Do NOT loop the map straight into executing-plans — the collapse preserves the linked detail (wayfinder rule). This ticket closes when spec.md exists and the map moves toward `/wayfind done`.

## Reconciliation (executed as this ticket's opening step, 2026-08-24)

The parallel t08 sibling branch (`kcard/ticket08-hotness-decay`) was reconciled BEFORE the to-spec collapse — user chose "land the whole delta": its unique automation (scheduleCardRebuild + trigger sites + retrieve usage echo, D41) landed as branch `kcard/rebuild-automation`; its hotness core stayed superseded by #1945 (conflicted with canonical D37/D39). The to-spec collapse therefore folds an ALREADY-LANDED automation, not a pending one.
