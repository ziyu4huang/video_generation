**ID:** `ADR-subagent-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# 0004 — Global detach shortcut is `alt+s`, not `ctrl+b`

**Status:** accepted
**Date:** 2026-08-16
**Amends the global detach key introduced with Task 06 of the cc-subagent-tui effort.**

## Context

The extension registered its global detach-to-background shortcut — "background
the oldest live foreground subagent run" — on `ctrl+b`. That key is pi's
built-in default for `tui.editor.cursorLeft`.

pi's extension conflict semantics hard-skip only a small RESERVED set
(submit/confirm/cancel/copy/followUp/deleteToLineEnd plus a few `app.*`
actions); `cursorLeft` is not on it. So the extension *claimed* the key, and
every pi startup printed:

```
Extension shortcut conflict: 'ctrl+b' is built-in shortcut for
tui.editor.cursorLeft and <inline:s2-agent-ext-subagent>. Using
<inline:s2-agent-ext-subagent>.
```

Two costs beyond the noise: the main editor silently lost ctrl+b
cursor-left (an Emacs-muscle-memory key), and the warning trained people to
ignore startup diagnostics.

### History of the rebinding attempts

- **#1481** rebound the global chord ctrl+b → `ctrl+shift+b` to silence the
  warning. **#1492 reverted it**: pi-tui matches `ctrl+shift+<letter>` only
  via the Kitty keyboard protocol (CSI-u) or xterm/tmux modifyOtherKeys — its
  `shift+ctrl` branch has no legacy fallback. On a terminal that negotiates
  neither (macOS Terminal.app is the common case) the chord was unreachable
  and the global detach silently did nothing. The revert's rationale: a
  visible warning beats a silently dead feature — so ctrl+b came back with
  the warning deliberately accepted.
- **This ADR** is the resurrection of the never-merged `alt+s` rebind
  (originally drafted as local commit e253e293, adapted to the post-#1492
  tree): `alt+<letter>` is the modifier family pi-tui DOES parse on legacy
  terminals — the ESC-prefix branch (ESC+s → `alt+s`, pi-tui dist/keys.js)
  — so the chord is both conflict-free AND deliverable everywhere.

One other ctrl+b surface exists and is **scoped** — it only acts while no
pi editor is focused, so it cannot shadow built-in editor bindings and
produces no warning:

- the in-viewer detach in the `/subagents` viewer (`subagent-viewer.ts`), a
  raw `\x02` byte sniff that never registers a keybinding.

## Decision

The GLOBAL shortcut moves to `alt+s`. It is free of every pi built-in default
(no `tui.*` or `app.*` binding uses it), so it claims cleanly: no warning,
shadows nothing.

The scoped in-viewer surface keeps `ctrl+b` deliberately — renaming it would
be churn for no functional gain, and its key never leaves its own surface.

Terminal caveat: `alt+s` requires the terminal to send ESC+s for Option+S —
iTerm2: Profiles → Keys → Option key = "Esc+" (user-confirmed configuration);
macOS Terminal.app: "Use Option as Esc+" (Preferences → Profiles → Keyboard);
Ghostty and kitty pass `alt+s` through by default.

Naming: `ctrl-b.ts` / `dispatchCtrlB` keep their names — they own the pure
dispatch logic now shared by both surfaces; only the global *binding* changed.

## Consequences

- The startup warning is gone and the editor's ctrl+b cursor-left works again.
- A repo-wide guard test (`bun-apps/s2-agent/src/__tests__/
  extension-shortcut-guard.test.ts`) loads every registered extension — static
  (`STATIC_EXTENSION_FACTORIES`) and dynamic (`run-dir/manifest.json`) — through
  a recording mock and fails if any registered shortcut collides with a pi
  built-in default key (`TUI_KEYBINDINGS[*].defaultKeys` at runtime plus the
  documented `app.*` table) or if two extensions claim the same key. This
  failure class cannot silently return.
- On a pi upgrade that changes built-in defaults, the guard's `tui.*` half
  tracks automatically; only the hardcoded `app.*` table needs manual sync.
- `tests/detach-key-deliverable.test.ts` pins deliverability: with the Kitty
  protocol inactive, `matchesKey("\x1bs", "alt+s")` must hold (the legacy
  ESC-prefix fallback), and the in-viewer `\x02` must parse to a DISTINCT
  `ctrl+b`.
- Users on a terminal that neither sends ESC+s for Option+S nor negotiates
  Kitty CSI-u lose the global detach key (it never reaches the app); the
  `/subagents` viewer's in-viewer ctrl+b still works.

## Alternatives considered

- **Keep ctrl+b and suppress the warning.** The warning is pi's only signal
  that a built-in was shadowed; silencing it hides real conflicts too.
- **Rebind to ctrl+shift+b (#1481).** Reverted by #1492: no legacy-terminal
  fallback in pi-tui for `ctrl+shift+<letter>` — the feature becomes a silent
  no-op exactly where the user least expects it.
- **Reserve ctrl+b via the `\x02` byte-sniff on `onTerminalInput`.** A raw
  terminal-input listener would see the byte before the editor, reproducing
  the same shadowing with extra machinery — moot once the key is free.
- **Rebind the scoped in-viewer surface to alt+s too.** It cannot collide
  (no editor is active on its surface), and ctrl+b is the Emacs-friendly
  binding where it works.
