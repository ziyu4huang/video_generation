---
name: webui-audit
description: Use when the pi webui (pi-agent-ext-webui) changes, when the user reports a webui/UI problem (small frames, broken exports, console noise, layout), or when verifying webui work end-to-end. Drives the power-tool `webui` tool (headless Chrome + Playwright) to audit the LIVE shell, publish findings into its Report tab, and dig deeper when invariants fail.
allowed-tools: Bash(bun:*), Bash(curl:*), Bash(lsof:*)
---

# webui audit — verify the live webui in one call

## When

- Any change to `bun-apps/pi-agent-ext-webui` (shell, routes, wiring, persistence).
- The user reports a webui symptom: tiny iframe, downloads doing nothing,
  scrollbar in the wrong place, "it shows nothing", console errors.
- Before declaring webui work done — audit is the acceptance gate.

## One call

Ask the session to `call webui` (power_browser gate family). Default port
8890, publish on: the audit report lands IN the audited webui's Report tab
(dogfood) and in `~/.pi/power-browser/runs/`. `publish: false` to opt out.

## Reading the 7 findings

panes-exclusive · ask-cards-located · viewer-cards-located ·
report-articles-located · report-iframe-sized (>= 320x300, measured with the
pane SHOWN — 0x0 means unmeasured, not failed) · zero-page-errors ·
zero-console-errors. A FAIL names the offender; screenshots sit next to
steps.jsonl in the run dir.

## Digging deeper (proven techniques)

- **Console 404 with no URL in the text**: read `msg.location().url` —
  Chromium strips the URL from the text but not the location (this is how a
  favicon.ico 404 was found). Empty-slot semantics beat suppression: an empty
  main view should answer 204, not 404.
- **Exports "do nothing"**: sandbox without `allow-downloads` blocks them
  silently. Prove with `context = browser.newContext({ acceptDownloads: true })`
  + `page.waitForEvent("download")` against the artifact's real menu — a real
  download event with a suggested filename is the only trustworthy pass.
- **Composition-level proof**: boot the REAL `wireWebui` (not a shell stub)
  with `WEBUI_REPORT_DIR` pointed at a seeded dir; the server starts LAZILY —
  fire the captured `session_start` handler like a real host. Then audit; the
  outline should list the restored reports (persistence round-trip).
- **Geometry of hidden panes is 0x0**: show the tab before measuring.

## After fixing

Re-run the audit until 7/7 PASS. Ship the fix; the audit trail + published
report are the receipt.
