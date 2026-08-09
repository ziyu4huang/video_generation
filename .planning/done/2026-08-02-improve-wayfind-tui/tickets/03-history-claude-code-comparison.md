## Question

How does pi's Up/Down input-history behavior compare to claude-code end-to-end? Confirm/capture:

- **Trigger conditions** — pi recalls on Up only when the cursor is on the first visual line (or the editor is empty / already browsing); `cursorDown` moves forward only while browsing and on the last line (`pi-tui/dist/components/editor.js:664-682`, `navigateHistory` at 322-356). What exactly does claude-code require?
- **Down at newest** — does claude-code restore the in-progress draft like pi does (`historyDraft`)?
- **Multi-line handling** — how does each behave when the input spans multiple lines?
- **Policy** — max history length (pi caps at 100, `editor.js:305`), dedup (pi skips if identical to most recent, line 301).

Source: claude-code docs / observed behavior + the pi-tui editor source cited above.

type: research
blocked by: _(none)_

## Resolution

**pi already matches claude-code's *intended* Up/Down behavior.** claude-code v2.1.169+ docs: Up/Down (aliases `Ctrl+P`/`Ctrl+N`) move the cursor within multiline/wrapped input first, then navigate history once at the first/last visual row — exactly pi's rule (`cursorUp` recalls on first visual line; `cursorDown` moves forward while browsing on the last line). claude-code also offers **`Ctrl+R` reverse-incremental history search** (and `/`).

Caveat: claude-code has a *recurring regression* (v2.1.149+) where Up jumps straight to history instead of moving the cursor — widely reported as a **bug**, not the intended design. So pi's current trigger is correct; do **not** "relax" it (that would reproduce claude-code's bug).

Real parity gaps for pi: (1) `Ctrl+R` reverse search, (2) `Ctrl+P`/`Ctrl+N` aliases, (3) discoverability (→ [06](06-history-trigger-and-hints.md)). History cap/dedup already align (pi: cap 100, skip-dup-of-most-recent).

Sources: code.claude.com/docs/en/interactive-mode; github issues 63191, 63670, 62922.

closed: 2026-08-02
