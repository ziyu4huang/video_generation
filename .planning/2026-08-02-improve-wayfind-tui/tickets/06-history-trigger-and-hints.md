## Question

Given [03](03-history-claude-code-comparison.md) — pi's trigger already matches claude-code's *intended* behavior, and claude-code's "Up jumps straight to history" is a known **bug**, not a target. So:

1. **Keep the trigger** (first/last-visual-line) — confirmed correct. ~~Relax it?~~ → **No.**
2. **Add `Ctrl+R` reverse-incremental history search** (claude-code's main history feature pi lacks)? Optional `Ctrl+P`/`Ctrl+N` aliases too?
3. **Discoverability** — surface `↑/↓ browse history` in the **startup keybinding hint strip**, not just the help table (`interactive-mode.js:4850`)?

type: grilling
claimed: wayfind-session (2026-08-02)
blocked by: 03

## Resolution

**Ship the discoverability hint; defer Ctrl+R; aliases are dead.** Decided:

- **Trigger: keep as-is** (first/last-visual-line Up/Down). claude-code's "Up jumps straight to history" is a bug, not a target. (Settled in [03](03-history-claude-code-comparison.md).)
- **Discoverability: YES** — surface `↑/↓ browse history` in the **startup keybinding hint strip** (`interactive-mode.js:506-522`). Today the strip lists ~12 hints (interrupt, clear, exit, model select…) with no history mention; the Up/Down hint only lives in the help table (line 4850).
  - *Implementation note:* the strip is compiled core, so this lands via the monkey-patch flow (`bun-apps/pi-agent/src/patches/`) — append a history hint to the startup instructions. Up/Down isn't a registered keybinding name (built into the editor), so it's a hardcoded `keyHint`-style entry, not `hint("app.x")`. Confirm during planning whether an extension hook to contribute startup hints exists (would avoid the patch).
- **Ctrl+R reverse-incremental search: DEFERRED.** Ctrl+R is free in main mode (the claude-code feature pi lacks), but it's a medium-effort feature (search-mode overlay via the patch flow). Revisit if wanted; it would also search the persisted history from [05](05-history-persistence-policy.md).
- **Ctrl+P / Ctrl+N aliases: DEAD.** Both taken in main mode — `Ctrl+P` = `app.model.cycleForward` (model cycling), `Ctrl+N` = `app.session.toggleNamedFilter`. Off the table without rebinding core keys.

closed: 2026-08-02
