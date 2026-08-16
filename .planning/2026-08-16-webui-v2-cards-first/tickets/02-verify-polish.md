status: open

# 02 — verify + polish

Goal: post-removal correctness + docs. Steps:
1. Replay: snapshot replay still renders transcript frames + cards + present view in #content (presentId auto-focus path intact; SSE live path intact). Add/adjust one replay test if coverage dropped in t01.
2. README: replace stale btw/views sections with "Cards-first v2" (two tabs; presentation surface; cards kinds; deep links; decision log path).
3. Full suite green (real lines); innerHTML ≤ 11.
Acceptance: gates green; README accurate vs shell.
