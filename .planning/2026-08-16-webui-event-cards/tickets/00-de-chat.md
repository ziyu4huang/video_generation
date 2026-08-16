---
status: closed
---
# 00 — de-chat: remove main composer, fix btw IME, simplify layout

## Goal
Chat lives in the TUI. Remove the webui main composer so the client-end surface
stops duplicating it; fix the remaining IME defect in the btw sidebar.

## Tasks
1. render-shell.ts: remove the `#webui-input` composer row + `#webui-send`
   (and the Abort affordance if it lives in that row); transcript goes
   full-height.
2. webui-wiring.ts: remove composer listeners + the prompt-dispatch path feeding
   the mutex gate → sendUserMessage main flow. Keep sendRaw/queue machinery if
   the btw sidebar uses it; retire dead code otherwise.
3. btw sidebar: Enter handler ignores `e.isComposing || e.keyCode === 229`.
4. Tests: update/replace assertions touching `#webui-input`/`#webui-send`;
   add one test proving IME-composed Enter does not send.
5. README: swap composer docs for the new model (chat in TUI; ask via btw/cards).

## Acceptance
- No `#webui-input`/`#webui-send` in served HTML; typecheck + webui suite 0 fail.
- IME-composition Enter no-ops in btw input (test-covered).

## Result
00: main composer removed (chat in TUI); btw Enter IME-guarded (isComposing/229) + isSendEnter helper; dispatch no-ops agentic frames; sendRaw/queue/mutex-gate kept.
