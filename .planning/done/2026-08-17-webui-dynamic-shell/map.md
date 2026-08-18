# webui-dynamic-shell — content adapts to browser size

status: done

## Why

User: "the webui should adjust content dynamically based on browser size."
The shell was document-flow: panes capped by fixed max-height (70vh after
PR #1576 — still a cap, not a fill), main capped at max-width 1100px, and the
page itself scrolled below the fold on short windows. An app-shell layout
fills whatever viewport it is given.

## What (PR #1577)

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

## Live UX measurement (2026-08-18, post-#1592-era code on :8890)

Playwright against the live shell (1440x900), Report tab, after scrollIntoView per article:

- 8 articles (4 markdown, 4 html iframes), all restored + live-published mix.
- Scroll chain from innermost content to body: EXACTLY ONE scrollable ancestor (report-pane, 817px client vs 4189px scroll); body overflow hidden, page never scrolls — the #1577 app-shell holds on the LIVE process.
- HTML iframes: 1408x630 (70vh) fully in viewport (visibleFraction 1.0) after one scrollIntoView; sandbox allow-scripts allow-downloads; fullscreen + open-standalone buttons present on every html article.
- The 2 console 404s (favicon + main-slot) are the pre-#1592 process — fixes merged, pending the user restart.

Reading a report = ONE pane scroll + (optional) ONE inner-frame scroll. Recorded so future layout work starts from measured numbers, not impressions.
