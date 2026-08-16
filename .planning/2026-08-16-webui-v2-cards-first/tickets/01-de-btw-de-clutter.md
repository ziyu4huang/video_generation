status: closed

# 01 — de-btw + de-clutter

Goal: remove the btw webui surface, views list panel, TURN dividers, meta panel. Mechanical deletions + test updates. Steps (anchors from live exploration 2026-08-16):
1. Wiring (src/webui-wiring.ts): remove btw imports (createBtwRoutes/createBtwForwarder/createBtwStore; emitBtwCommand/onBtwEvent + btwCommandFromFrame/isBtwEvent from btw-channels), btwStore/forwarder seam ~L470-476, inbound case "btw" ~L681, /api/btw routes ~L746-754. Delete src/btw-routes.ts, src/btw-store.ts, src/btw-channels.ts (grep imports first — nothing else may import them).
2. Shell (src/render-shell.ts): remove #btw-panel HTML L146-171 + its CSS, btwState/btwModels + fetch('/api/btw'...) L836-923, btwApplyEvent + 'btw' frame branch L330, btw collapse localStorage handling, btw Enter/IME handlers (check isSendEnter export — if only btw tests use it, remove export + tests). Remove #webui-views-panel HTML/CSS/JS + loadViews polling + "no view" L238 path + views-count/collapse; KEEP SSE present auto-focus (L277-289) + renderView for presentId-carrying views + Approve/controls bar + sendAppexecResponse/cancel. Remove .tx-turn CSS L103 + txApply turn-divider branch. Remove #meta div L140 + its writer (keep #session-status).
3. Tests: delete/trim btw webui tests (btw-contract.test.ts etc. — grep -l btw tests/), views-panel assertions, turn/meta assertions. Count will DROP — report real before/after.
Acceptance: typecheck clean; bun test 0 fail (real lines); grep -ci btw src/render-shell.ts = 0; grep -c innerHTML ≤ 11.

## Result
Closed at d5407fc8: btw sidebar + views panel + TURN dividers + meta panel removed (16 files, +30/-1689). Gates: typecheck clean; bun test 458 pass / 0 fail (31 files; was 521/0/38 - 6 btw test files + shell-views.test.ts died with their features); grep -ci btw render-shell.ts = 0; grep -c innerHTML = 8. Deviations: (1) openViewUrl/viewUrlHandles/viewOpenedId/viewEntries deleted too (viewEntries was fed only by viewApplyFrame - kept funcs would be dead; url-mode tab click/renderView branch = inert no-op return, 02-A sandbox guardrail intact); (2) none other.
