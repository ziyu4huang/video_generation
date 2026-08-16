---
id: 03
title: "shell rebuild: 3 tabs, transcript gone"
status: open
---

## Goal
D1+D2: render-shell rebuilt lean — tabs Inbox/Report/Data, no transcript pane.

## Notes for implementer
- Template: #content present surface + #tabs + three panes (#inbox-pane rename
  of #cards-pane? KEEP id cards-pane to avoid test churn — label changes to
  'Inbox'; ask routing target stays).
- Delete: #webui-transcript div, txEl/txLine/txAppend/txRenderSnapshot
  transcript logic, message/tool/tool_result renderers, ask dialog appendix
  path (tool_result questionnaire detection moves WITH the diet — ask cards
  own the questionnaire UI), tx-* CSS.
- Keep: renderCard + routing, retireCard + answers review, report renderer,
  viewer sandbox, bell + hash deep links, present SSE + appexec bar, controls.
- txApply shrinks to: card/card_done/report/ask_user/ask_user_done/appexec/
  session_info/error/mutex/view_opened.
- Watch the template-literal escape class (regex/newline doubling) — parse
  guard test exists; run it.

## Done when
Shell renders 3 tabs; zero transcript markup; suite green; Chrome probe
screenshot attached to ticket.
