---
effort: 2026-08-08-subagent-display-glanceable-by-default
created: 2026-08-08
last: 2026-08-10
status: active
---

## Destination
Every subagent display surface — the live context-widget AND completed `subagents`/`subagent` tool results — is glanceable by default: collapsed, one-line summaries, no verbose dumps. Full detail expands on Ctrl-O, reusing the context-widget's collapse/expand pattern.

## Notes
- The live context-widget already does collapse-by-default + Ctrl-O expand (#1078 box toggle; #1097 collapsed prose/activity live-line + expanded grouped call/result trace). That surface is DONE.
- This effort extends the same pattern to COMPLETED tool-result displays — the `subagents` fan-out batch result dumps full per-child output by default (see ticket 01).
- Ticket 03 — BUG: subagent display may show an incorrect model id (e.g. `anthropic/claude-opus-4-1` when the env's actual/default models are GLM + deepseek). Root-cause needed: display showing requested-model-with-silent-fallback, or resolution/storage bug? Related to ticket 02 (both header accuracy). CLOSED via #1103.
- Ticket 04 — post-merge display-review regression fixes (#1101 work-intent strip dead on the docked context box; #1103 actual-model-on-fallback never extended to the `subagents` batch tool; fallback `→` vanishes on settle + missing on context-box header; collapsed call/result lines overflow on long model ids). One PR.
- Ticket 05 — post-#1108 display-review polish, 2 P2s: (4) context-box expanded trace is uncapped, a latent #1104 whole-TUI flicker re-introduction since Ctrl-O expands BOTH surfaces together via `{ consume: false }`; (6) collapsed batch per-slot badge widths vary by terminal status, leaving the `model · elapsed · task` columns drifting between rows. One PR.

## Decisions so far
- (none yet — first ticket filed 2026-08-08)

## Not yet specified
- Whether the `subagent` (single) tool result needs the same treatment (only `subagents` batch is flagged so far).
- Whether Ctrl-O expands all batch children at once or per-child.

## Out of scope
- (none yet)

## Cross-effort links
- Builds-on: `.planning/done/2026-08-07-continue-improve-pi-ext-subagents-related-still-` (verb-led logs + context-widget collapse/expand foundation).
- Builds-on: `.planning/done/2026-08-07-current-subagent-run-show-in-context-and-bottom-` (the persistent context widget).
