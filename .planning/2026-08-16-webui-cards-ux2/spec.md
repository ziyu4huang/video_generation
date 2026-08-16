# spec — webui-cards-ux2

Scope: answer round-trip correctness; answered-card review UX (no duplicate echo); non-blocking draft cards with one-shot send + session injection. Out of scope: ask questionnaire modality (stays modal), archify cards, viewer sandbox, bell/deep-link (unchanged).

Contracts: card frame += blocking?:boolean; appexec loose card_send {cardId, answers} (guarded top, card_answer pattern); answered cards = collapsed read-only review (D1/D2); sent cards = frozen + sentAt (D3/D4); delivery via sendUserMessage (D5). Baseline: webui 458/0, innerHTML 8.
