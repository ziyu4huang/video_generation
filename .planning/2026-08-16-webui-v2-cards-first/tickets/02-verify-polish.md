status: closed

# 02 — verify + polish

Goal: post-removal correctness + docs. Steps:
1. Replay: snapshot replay still renders transcript frames + cards + present view in #content (presentId auto-focus path intact; SSE live path intact). Add/adjust one replay test if coverage dropped in t01.
2. README: replace stale btw/views sections with "Cards-first v2" (two tabs; presentation surface; cards kinds; deep links; decision log path).
3. Full suite green (real lines); innerHTML ≤ 11.
Acceptance: gates green; README accurate vs shell.

## Result
Closed at e1fa83c9: replay coverage verdict — ALL COVERED, no new test needed ((a) transcript snapshot replay: webui-wiring "wsOpenHandler pushes a snapshot" + shell `state.transcript.forEach(txApply)`; (b) card/card_done replay order: render-shell-cards txApply tests + wiring snooped-card snapshot test; (c) present auto-focus: render-shell-controls SSE presentId probe + renderControls/renderView + APPEXEC_FRAME respond wire shape + wiring present-tool e2e respond→execute). README v2: "Cards-first v2" section replaces btw/views-panel sections (+32/-42). Gates: typecheck clean; bun test 458 pass / 0 fail (31 files); grep -c innerHTML = 8.
