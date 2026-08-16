status: open

# 02 — non-blocking draft cards

Steps:
1. protocol.ts: card frame += `blocking?: boolean` (absent/true = modal, current). Validate inbound card_send {cardId, answers<string map>} (mirror card_answer validation).
2. webui-wiring.ts: onCommand TOP guard for extra.kind "card_send": first-send-wins Set; append JSONL line {ts, cardId, answers, channel:"card_send"}; broadcast card_done {id, ts}; then DELIVER: pi.sendUserMessage(`[card ${cardId}] ${title??""} ${JSON.stringify(answers)}`) — find the exact sendUserMessage seam on the wiring's pi host surface (de-chat retired ROUTING, the method should still exist; if the surface lacks it, add an injectable dep `sendMessage` defaulting to the pi method, tests stub it). Non-blocking producers: add a tiny helper/export so future tools can emit blocking:false cards; pilot: convert ONE existing ask-card mirror? NO — ask stays modal (user said modal is fine for questionnaires); non-blocking is opt-in for future producers.
3. render-shell.ts: blocking:false interactive cards render as draft forms with a "Send" button + subtle "draft" badge; NEVER auto-retire on card_done (card_done = freeze+stamp: disable inputs, show `sent <time>`); live + replay; replayed already-sent cards render frozen. Esc/refresh keeps the draft (form state lives in DOM; snapshot replay re-renders from the last card frame — document that draft INPUT is not persisted across refresh, only card structure; acceptable v1).
4. Tests: frame validation (blocking flag + card_send shapes); wiring guard (first-send-wins, JSONL, card_done, sendMessage called with the formatted text); shell (draft render, send click -> card_send envelope, freeze on card_done, replay frozen).
5. Gates: typecheck clean; bun test 0 fail (REAL lines); innerHTML <= 8.
Acceptance: a blocking:false card sits as a draft; send any time; frozen + stamped after; agent receives it as an injected message; gates green.
