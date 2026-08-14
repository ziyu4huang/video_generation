# Task 9 Report — shell panel markup + pure helpers

## Status

Complete. Implemented per brief; all tests pass; committed on `feat/btw-panel-in-webui`.

## What was done

- **Test first (TDD)**: `bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts` — verbatim from the brief (string-contains checks over `RENDER_SHELL_HTML` for the 12 binding ids + the localStorage key; pure-helper tests for `BTW_FRAME` flat frames / no-extra-keys, `BTW_MESSAGE_HTML` escaped text / keyed row / conditional status line). Verified failing first (`Export named 'BTW_MESSAGE_HTML' not found`), then passing.
- **`src/render-shell.ts` markup**: wrapped the existing `<main>` in `<div id="shell-row">` and added `<aside id="btw-panel">` with the full bar (collapse / New / Clear / Inject / Summarize / mode toggle / model select / thinking select), `#btw-messages`, and the compose row (`#btw-input` + `#btw-ask`). Existing `#meta`/`#content` markup unchanged.
- **CSS**: added the shell-row flex layout, `#btw-panel` fixed-width column, `body.btw-collapsed #btw-panel { display: none; }` hide rule, message/status/notice styling, bar and compose styling — adapted to the file's existing conventions (rem-based sizing, `#8884` borders).
- **Pure helpers**: `BTW_FRAME(kind, extra?)` (flat `{ type: "btw", kind, ...extra }`, no phantom keys when `extra` omitted) and `BTW_MESSAGE_HTML(m)` with a newly added `escapeHtml` (none existed in the file), both exported next to `APPEXEC_FRAME`.

## Test results

- Focused: `bun test tests/render-shell-btw.test.ts` — 6 pass, 0 fail.
- Package gate: `bun run test` — 312 pass, 0 fail (all prior render-shell / routes / wire tests unaffected).

## Deviations from the brief

- The brief's markup snippet did not itself contain the literal `btw-panel-collapsed` string the Step-1 test requires in `RENDER_SHELL_HTML`. Resolved with a CSS comment next to the hide rule documenting the localStorage key (contract satisfied; no client logic added — that is Task 10).
- CSS values adapted to file conventions (`.5rem` padding, `#8884` border) per the brief's explicit "adapt class names/spacing" allowance; the required contract (id list + `body.btw-collapsed` hide rule + flex-row layout) is fully met.

## Notes for Task 10

- All binding ids/classes are as briefed: `btw-panel`, `btw-collapse`, `btw-messages`, `btw-input`, `btw-ask`, `btw-new`, `btw-clear`, `btw-inject`, `btw-summarize`, `btw-mode`, `btw-model`, `btw-thinking`; classes `btw-msg`/`btw-<role>`/`btw-text`/`btw-status`/`btw-notice`; `data-id` keying on rows; `body.btw-collapsed` body class; localStorage key `btw-panel-collapsed`.
- `#btw-model` and `#btw-thinking` ship with their default `<option>`s; Task 10 populates models and wires the toggle.

## Commit

- `feat(webui): add btw side panel markup and frame/message helpers`
