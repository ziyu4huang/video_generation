# webui-report-iframe-fix — size the Report tab iframe

status: done

## Why

User report: the Report view renders a VERY small iframe — usage very bad.
Driven the t01 webui audit pipeline (power-tool, headless Chrome) + a geometry
probe against the live :8890:

- report iframe measured 304x154, min-height 0 — the browser default 300x150.
  The existing sizing rule (#content iframe, min-height 70vh) never matched:
  the panes are not inside #content; t02's html-report branch was added with
  NO sizing rule at all.
- #report-pane capped by the v2-era max-height:45vh (405px on a 900px
  viewport) — a leftover from the transcript layout where panes were side
  strips; post-t03 they are the primary surfaces.
- dead #ask-pane CSS selectors survived t03.

## What (PR #1576)

- #report-pane article iframe: width 100%, min-height 70vh (mirrors the
  present-surface frame rule).
- panes (#cards-pane, #report-pane, #data-pane): cap 45vh -> 70vh; dead
  #ask-pane selectors removed.
- fullscreen button on every html report article (requestFullscreen) — the
  sandboxed iframe has an opaque origin, so the parent can never measure the
  inner document; tall diagrams get an escape hatch instead of nested scroll.
- guards in tests/tab-views.test.ts (rule present, 45vh gone, ask-pane gone,
  requestFullscreen present).

## Follow-ups

- audit surfaced 2x console 404 resource errors on the live page (unidentified
  — likely favicon-class); ticket separately if reproducible.
- #content (present surface) measures h:0 when idle — harmless today, note for
  any future present-surface work.

## Verification

webui suite 0 fail (guards added); live re-audit (webui tool + geometry probe)
to be re-run after the user restarts pi onto this code.
