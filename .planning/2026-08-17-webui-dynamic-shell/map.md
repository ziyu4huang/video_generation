# webui-dynamic-shell — content adapts to browser size

status: done

## Why

User: "the webui should adjust content dynamically based on browser size."
The shell was document-flow: panes capped by fixed max-height (70vh after
PR #1576 — still a cap, not a fill), main capped at max-width 1100px, and the
page itself scrolled below the fold on short windows. An app-shell layout
fills whatever viewport it is given.

## What (PR #<PR>)

- body: height 100dvh, flex column, overflow hidden — the page never scrolls;
  panes do (internally).
- header: flex none. main: flex 1 + min-height 0 + overflow hidden; width cap
  1100 -> 1500px (wide screens get wider diagrams).
- #content (present surface): flex fill + internal scroll; ':empty' hides it
  entirely while idle so the active pane owns the full height.
- panes (#cards-pane/#report-pane/#data-pane): max-height caps REPLACED by
  flex: 1 + min-height: 0 — they fill exactly the available height at ANY
  window size.
- guards updated in tests/tab-views.test.ts (100dvh + flex-fill present,
  max-height caps gone).

## Verification

webui suite 0 fail; template parse guard PARSE-OK; three-viewport headless
probe (1920x1080 / 1440x900 / 390x844): pane height tracks viewport height
(header + padding overhead only).
