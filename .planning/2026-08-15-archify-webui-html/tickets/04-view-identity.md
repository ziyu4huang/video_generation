---
ticket: 04-view-identity
effort: archify-webui-html
type: decision
status: closed
created: 2026-08-15
last: 2026-08-16
blocking: none
---
# 04 — View identity & lifecycle for diagram tabs

## Question

View identity & lifecycle for diagram tabs:

- view id scheme — per diagram type? per IR `meta.output` basename? single "archify" view
  replaced each render?
- title;
- replace-on-rerender expectations;
- does `ui.notify` announce each render or only first view?
- how is delta-compare output (`archify_delta`) named?

## Decision

**View = IR output basename sans extension; re-render replaces the same view.**

- `view` = basename of `ir.meta.output` (the rendered outPath) minus extension — a re-render
  of the same diagram lands on the same view id.
- `archify_delta` compare output → `compare-<basename>`.
- `title` = `ir.meta.title ?? diagramType`.
- These inform the `ui.notify` label (each open announces `${title} — ${url}`) and are
  forward-compat with future shell tabs (ticket 05 lineage). Note: decision 01-A means NO
  webui shell tab is created today — the URL opens as a top-level browser tab; `view`/`title`
  ride the event payload for labeling and future use only.

## Acceptance

- Recorded; no ambiguity remains for the emitter ticket (02).
