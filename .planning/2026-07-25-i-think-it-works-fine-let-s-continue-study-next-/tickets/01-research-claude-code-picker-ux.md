---
type: research
blocked by: (none)
status: closed
claimed: wayfinder-chart-2026-07-25
---

# 01 — Research: claude-code's interactive picker UX

## Question

What is claude-code's exact interactive-picker behavior, specified well enough to drive a component spec? Cover: trigger(s) (`/`, `@`, inline), the filter-as-you-type model, full keyset (↓/↑, Tab, Enter, Esc, Home/End, PgUp/PgDn), mouse behaviour, scroll, multi-column vs single-column, empty/no-match state, selection highlight, dismissal semantics, and recent-items / fuzzy-match sorting. This is the reference the whole component is "copying".

## What resolving it looks like

A `web_search` / `fetch_content` pass (the user explicitly requested internet research) producing a behavior spec written back into this ticket as the resolution. Grounds ticket **05** (component spec + parity scope) and the fog items on mouse/scroll.

## Resolution

claude-code does **not** have one picker — it has **two distinct picker semantics**, each its own keybinding *context*. Source: official `code.claude.com/docs/en/keybindings` (authoritative) + GitHub issue reports (pitfalls).

### A. `Autocomplete` context — the in-line slash-command / suggestion menu
Triggered by typing `/` (commands) or `@` (file mentions). Filters as you type. Keyset:
| Action | Default key |
|---|---|
| `autocomplete:next` | **Down** |
| `autocomplete:previous` | **Up** |
| `autocomplete:accept` | **Tab** |
| `autocomplete:dismiss` | **Escape** |

Note: **Tab** accepts (not Enter) — Enter submits the chat message. This is the inline-suggestion model.

### B. `Select` context — modal list pickers (model picker, message selector, plugin, diff file list)
| Action | Default keys |
|---|---|
| `select:next` | **Down, J, Ctrl+N** |
| `select:previous` | **Up, K, Ctrl+P** |
| `select:accept` | **Enter** |
| `select:cancel` | **Escape** |

Vim-style `J`/`K` + `Ctrl+N`/`Ctrl+P` aliases are standard here. Enter accepts (modal model).

### Architecture insight (drives our spec)
Keybindings are **context-scoped**: the same key (`Down`) routes to different actions depending on the active context (`Chat` → history-next, `Autocomplete` → next-suggestion, `Select` → next-option, `Footer` → down). A clean component mirrors this: a *context/focus stack* decides which handler owns each keystroke.

### Documented UX bugs to explicitly AVOID in our component
- **Prefix-match priority broken**: typing `/co` highlights `/context` but ↓ jumps to the *next* item, executing the wrong command (issue #34003).
- **Fuzzy over-ranks prefix**: `/comm` → `/pr_comments` instead of `/commit` (issue #11431). → Our filter must rank prefix matches first.
- **Trap-on-up**: pressing ↑ while typing accidentally opens the slash menu and traps arrow nav (issue #11265). → Opening must be intentional (`/`), not a stray arrow.
- **Raw escape leakage**: arrows emit `^[[B` ANSI codes instead of navigating (v2.1.92 regression, #43341). → Input parsing must consume the full escape sequence.
- **Double-highlight**: two entries highlighted, first unselectable (#11623).
- **`@`+Tab data loss**: Tab-accepting a file mention erases previously typed text (#32781). → Accept must *preserve* the buffer.

### Parity scope recommendation (feeds ticket 05)
**In scope**: ↓/↑ navigate, type-to-filter (prefix-priority), Tab-accept (autocomplete style) **or** Enter-accept (select style — decide in 05), Esc-dismiss, clean focus management (no stray-arrow traps), buffer preservation on accept.
**Defer / likely out of scope**: mouse, in-menu scroll, multi-column, fuzzy (non-prefix) matching, recent-items sorting — none are core to "copy claude-code's keyboard picker"; revisit only if a consumer needs them.
