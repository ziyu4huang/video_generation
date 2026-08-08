---
type: task
status: closed
origin: 2026-08-08-subagent-display-glanceable-by-default/tickets/05-contextbox-trace-cap-batch-badge-align.md
---

## Question

Post-`#1108` display-review polish — the two remaining P2 findings the review
flagged after the work-intent / fallback consistency PR landed. Both are
defensive / glanceability fixes; neither changes the expanded/verbatim viewer,
the fallback display (#1108), or the inline cap value.

One cohesive PR: "subagent display polish 2 — context-box trace cap + batch
column alignment".

## Findings

### Finding 4 (P2) — context-box expanded trace is uncapped (latent #1104 flicker re-introduction)

`#1104` capped the INLINE streaming-expanded view
(`STREAMING_EXPANDED_TAIL` in `subagent-tool.ts`) to stop whole-TUI flicker
when a tall box trips `fullRender`. The context-box
(`subagent-context-widget.ts` `renderRun`'s expanded branch) renders the FULL
history via `formatSubagentTrace(...)` with no tail cap, then `.split("\n")`s
the whole thing into lines. `extensions/subagent.ts` wires Ctrl-O with
`{ consume: false }` so Ctrl-O expands BOTH surfaces together — so the moment a
background subagent streams a long trace, Ctrl-O would re-trip the exact flicker
`#1104` killed, on the surface `#1104` didn't touch. (Today this is unreachable
for tall traces — background runs render a no-trace header — but it's a latent
inconsistency.)

**Fix**: reuse the SAME tail-cap behavior in `renderRun`'s expanded branch. Read
the real `STREAMING_EXPANDED_TAIL` constant (do NOT hardcode); extract a shared
`capTraceTail(lines, tail)` helper and call it from BOTH the inline expanded path
(`renderSubagentResult` isPartial+expanded) and the context-box expanded path
(DRY). The extraction must be byte-identical on the inline surface (its existing
cap test must still pass). The inline cap value itself is unchanged.

**Do NOT uncap the inline surface.** The cap must hold on both surfaces.

### Finding 6 (P2) — collapsed batch per-slot columns don't align

`subagents-tool.ts` `renderSubagentsResult` collapsed branch builds the per-slot
line with a status badge whose text width varies by terminal status:
`✓ done` / `⏱ timedout` / `⛔ budget` / `⊘ aborted` / `✗ failed`. Unequal badge
widths leave the `model · elapsed · task` columns drifting between rows, so a
quick vertical scan of an N-children batch isn't aligned.

**Fix**: pad the badge text (`padEnd`) to the widest badge width
(`⏱ timedout` = 10 chars) before joining the slot line, so every slot's badge
segment is the same width and the following columns line up. Fixed-width pad
only — no terminal-width dependency. Use the actual badge strings the renderer
emits.

## Constraints

- Do NOT change the expanded/verbatim (viewer/persistence) path.
- Do NOT uncap the streaming-expanded tail (`#1104` fix must hold on both surfaces).
- Do NOT touch the inline cap value.
- Do NOT change the `#1108` fallback display.

## Resolution

Shipped via #1110 (`fix(subagent): context-box trace tail-cap + batch per-slot badge alignment`).

Implemented in `fix/subagent-trace-cap-batch-align`:
- `STREAMING_EXPANDED_TAIL` exported + shared `capTraceTail(lines, tail)` helper
  in `subagent-tool.ts`; inline expanded path refactored to use it (byte-identical).
- `subagent-context-widget.ts` `renderRun` expanded branch caps the trace via
  `capTraceTail(..., STREAMING_EXPANDED_TAIL)`.
- `subagents-tool.ts` collapsed batch per-slot badge padded to a fixed width
  via a `BATCH_STATUS_BADGES` map + `BATCH_BADGE_WIDTH` + `batchStatusBadge()`.
- Tests: long-history context-box cap test + mixed-status batch column-align test.
