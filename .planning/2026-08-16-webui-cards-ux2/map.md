# webui-cards-ux2

Goal: two user-reported card UX gaps + one correctness bug. (1) answered questionnaire cards must stay REVIEWABLE (read-only question+answers, click to expand) and answers must NOT be duplicated into the transcript/appendix. (2) NEW non-blocking cards: deferred drafts the user answers ANY time; once sent -> stamped sentAt, immutable, never re-sendable; the send injects into the main session like typed input (agent never blocked). (3) BUG: browser ask-card answer resolves the tool but the orchestrator receives `undefined` (answer lands in transcript echo but not in the tool result) — fix the round-trip.

- Status: active
- Decisions:
  - D1 answered cards are collapsed reviewable (question + given answers, read-only), live + replay.
  - D2 no answer duplication: the answered card is the single source of truth; kill whatever appends the answer echo to the transcript/appendix (verify in repro).
  - D3 non-blocking = card frame field `blocking?: boolean` (default true = current modal semantics). blocking:false -> shell renders a DRAFT form that never auto-retires; submit -> one-shot send.
  - D4 sent semantics: on send, the card freezes (inputs disabled), shows sentAt, broadcasts card_done (retire path reused as freeze marker), and the answer rides a NEW appexec loose kind "card_send" {cardId, answers} guarded at onCommand TOP (card_answer pattern).
  - D5 delivery: card_send -> JSONL decision log + pi.sendUserMessage("[card <id>] <title>: <answers JSON>") — injects like typed input at the next turn boundary (de-chat left this seam available; agentic frames stay retired).
- Tickets:
  | # | ticket | status | result |
  | 01 | answer round-trip fix + reviewable answered cards + no appendix echo | closed | — |
  | 02 | non-blocking draft cards (blocking flag, card_send, sendUserMessage injection) + tests/docs | open | — |
