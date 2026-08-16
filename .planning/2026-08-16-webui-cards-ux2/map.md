# webui-cards-ux2

Goal: two user-reported card UX gaps + one correctness bug. (1) answered questionnaire cards must stay REVIEWABLE (read-only question+answers, click to expand) and answers must NOT be duplicated into the transcript/appendix. (2) NEW non-blocking cards: deferred drafts the user answers ANY time; once sent -> stamped sentAt, immutable, never re-sendable; the send injects into the main session like typed input (agent never blocked). (3) BUG: browser ask-card answer resolves the tool but the orchestrator receives `undefined` (answer lands in transcript echo but not in the tool result) — fix the round-trip.

- Status: active
- Effort summary: t01 answer round-trip fix + reviewable answered cards merged via PR #1539; t02 non-blocking draft cards shipped as 02a e0eb9dd1 (protocol `blocking?: boolean` flag, `CardSendExtra` + `validateCardSendExtra`, wiring onCommand TOP guard with first-send-wins JSONL + card_done broadcast + sendMessage seam injection, session_shutdown ledger reset, tests in nonblocking-cards.test.ts + protocol.test.ts, port-resolver env-isolation fix) and 02b shell commit 0db6695e (render-shell draft forms + draft badge + Send button + freezeDraftCard tombstone + APPEXEC_CARD_SEND twin, tests/nonblocking-shell.test.ts).
- Decisions:
  - D1 answered cards are collapsed reviewable (question + given answers, read-only), live + replay.
  - D2 no answer duplication: the answered card is the single source of truth; kill whatever appends the answer echo to the transcript/appendix (verify in repro).
  - D3 non-blocking = card frame field `blocking?: boolean` (default true = current modal semantics). blocking:false -> shell renders a DRAFT form that never auto-retires; submit -> one-shot send. ([02](tickets/02-nonblocking-cards.md))
  - D4 sent semantics: on send, the card freezes (inputs disabled), shows sentAt, broadcasts card_done (retire path reused as freeze marker), and the answer rides a NEW appexec loose kind "card_send" {cardId, answers} guarded at onCommand TOP (card_answer pattern). ([02](tickets/02-nonblocking-cards.md))
  - D5 delivery: card_send -> JSONL decision log + pi.sendUserMessage("[card <id>] <title>: <answers JSON>") — injects like typed input at the next turn boundary (de-chat left this seam available; agentic frames stay retired). ([02](tickets/02-nonblocking-cards.md))
- Tickets:
  | # | ticket | status | result |
  | 01 | answer round-trip fix + reviewable answered cards + no appendix echo | closed | — |
  | 02 | non-blocking draft cards (blocking flag, card_send, sendUserMessage injection) + tests/docs | closed | draft cards one-shot send -> card_send -> JSONL + card_done freeze + sendMessage injection; webui 481 pass / 0 fail, innerHTML 8; 02a e0eb9dd1 + 02b 0db6695e |
  | 03 | persist draft-card input across refresh/replay | open | — |
  | 04 | answered-card detail persistence for replay | open | — |
