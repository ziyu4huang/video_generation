status: open

# 02 — report producer helper + Data full-pane + deep links + README

Steps:
1. webui-wiring.ts: export `broadcastReport(broadcaster, {title, markdown|html, source})` helper (one line for producers); snoop? no — reports are explicit only. Maybe also pi.events channel "webui:report" → broadcast (mirror archify pattern) so tools can emit via the bus without the wiring object.
2. render-shell.ts: Data pane full-pane open (click row → iframe fills pane, Back row); #card-<id> hash: search ask/events/data panes for the article → activate owning tab → scrollIntoView + card-flash (extend handleCardHash; cold-load retry logic unchanged).
3. Ask pane ordering: pending before answered (CSS order or insert-before).
4. README: Tab guide section (five tabs, what lands where, deep links).
5. Tests: helper broadcast lands as report frame (wiring level); full-pane open/close literal; hash activates the OWNING tab for an ask card vs a data row (literal/DOM style).
Acceptance: typecheck clean; webui 0 fail REAL lines; innerHTML ≤ 8; ci-local PASS.

## Progress (02 producer slice)
POST /api/report shipped: strict validation (exactly one of markdown|html, title 1-200, 128KB cap), sync route contract preserved (POST branch defers via returned promise; route types widened Response | Promise<Response> | null), wiring injects broadcaster (store append = replay). Remaining for 02: Data full-pane + deep links + README.
