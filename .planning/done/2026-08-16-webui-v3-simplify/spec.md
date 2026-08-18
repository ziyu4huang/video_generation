# Spec: webui v3 — simplify + co-work with TUI (user-ratified D1–D4)

## D1 — Transcript removed
- render-shell: no transcript pane, no txLine/txAppend machinery, no
  message/tool renderers. Boot = tabs + panes only.
- Wiring: web clients no longer receive message_start/update/end,
  tool_execution_start/update/end, tool_result, turn_start/end, agent_settled,
  session_before_compact/compact (TUI-only frames).

## D2 — Three tabs
- Inbox: ask cards (id ask-*) + event/readonly cards, chronological.
- Report: report frames (md DOM builder / sandboxed html iframe — unchanged).
- Data: viewer cards; t03 keeps inline-iframes, full-pane expand is future.
- Pane switching exclusive; #card-<id> hash activates the OWNING tab.

## D3 — `webui` audit tool (pi-agent-ext-power-tool)
- Tool name `webui`, gated like browser (power_browser family or own gate).
- Input: {port?, checks?}. Default port resolution: probe 8890 then /api/views.
- One call produces: tab list, per-pane card/article outline (id/kind/title/
  attention), per-tab screenshot, console + pageerror collection, invariant
  checks (exclusive panes, ask-cards-in-inbox, viewer-in-data, report
  renders), and a compact audit report. Run-dir audit trail like browser-tool.

## D4 — Source diet
- Wiring allowlist (WEB_OUTBOUND_ALLOWLIST) filters outbound frames per type;
  snapshot builder keeps only interactive/persistent frames for web replay.
- Store: append only allowlisted types; if all sparse → drop the FIFO cap
  machinery (verify no other consumer).

## Non-goals
- No changes to TUI, to pi-agent core, or to the present/view toolchain.
