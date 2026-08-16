# spec — webui-v2-cards-first

Components after v2: shell tabs (Transcript, Cards); transcript (frames, no turn dividers, no meta); cards pane (readonly url cards, interactive ask cards, viewer sandbox + confirm gate — all shipped event-cards 00-05, unchanged); presentation surface #content (present HITL only: auto-focus on presentId, controls bar, appexec respond/cancel envelopes unchanged).

Removed: btw sidebar + webui btw seam (files btw-routes.ts, btw-store.ts, btw-channels.ts; wiring imports + onBtwEvent subscription ~L470-476 + inbound case "btw" ~L681 + /api/btw routes ~L746-754; shell #btw-panel L146-171 + btwState/fetch L836-923 + btwApplyEvent branch L330); views list panel (#webui-views-panel + loadViews polling + "no view" placeholder; KEEP SSE present auto-focus L277-289 and renderView for presentId views); .tx-turn CSS L103 + txApply divider branch; #meta div L140 + writer.

Answer envelopes (unchanged contracts): card_answer loose appexec extra (generic cards); ask_user_answer (ask cards); appexec respond via sendAppexecResponse L300-377 + cancel {kind:'cancel', id} (present gate); webui.emit → confirm card → card_answer (viewer).

Out of scope: pi-agent-ext-btw package, TUI, protocol card frame, archify cards (already correct).

Test plan: t01 — update/relocate btw tests (btw-contract.test.ts, wiring btw sections, shell btw literals, isSendEnter if btw-only → remove + tests), remove turn/meta assertions; real gate lines, 0 fail. t02 — replay/snapshot test for present-in-content still passing; README "Cards-first v2" section; full suite green.
