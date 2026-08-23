---
effort: 2026-08-22-s2-agent-compact-cc-style
created: 2026-08-22
last: 2026-08-23
status: complete
---
# s2-agent-compact-cc-style — Claude Code-style /compact for s2-agent

## Destination

`bun-apps/s2-agent-ext-compact` replaces the built-in compaction summary *content* with a
Claude Code-style 8-section prompt output (verbatim user messages, exact paths, current-work
quoting, `/compact <instructions>` passthrough), leaving cut-point selection, session-tree
handling and all failure paths to the host — proven by an offline blind A/B replay harness.

## Context (measured 2026-08-22 on this machine)

- The built-in 7-section summary loses what CC's compaction preserves; upstream
  `~/proj/pi-smart-compact` (24.7k LOC) proves the seam:
  `pi.on("session_before_compact")` returning
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` fully replaces the
  host summary, and any handler error silently falls back to built-in compaction.
- Single seam: reuse host `preparation` verbatim for `firstKeptEntryId`/`tokensBefore`;
  worst-case failure = summary quality regresses to built-in; the session tree can never be
  corrupted.
- Non-goals (deliberately not ported): yield gate, verify/repair loop, telemetry,
  backup/restore, context-graph.

## Tickets

Single-plan effort (`plans/plan.md`) + two blind-eval batches (`blind-eval/`):
- extension + registration (`load: static`, deploy YES) — **closed**
- A/B replay harness + batch 1 — **closed** (`ab-report.json`)
- blind eval batch 2 — **closed**: arm B wins 5/5, eval CLOSED, arm B stays default
  (#1836, 2026-08-23)

## Decisions

- **D1 — content-only replacement.** Cut points and session-tree handling stay the host's;
  the extension only swaps the summary text. This is what bounds the blast radius to
  "worse prose".
- **D2 — deploy: yes.** The extension must ride the portable `s2-agent.sh` tree
  (pure TS, zero native deps → clean base-set member).
- **D3 — measurability is part of done.** The offline blind A/B harness gates the change;
  batch-2 5/5 is the acceptance receipt.

## Frontier

cleared — shipped on `feat/s2-agent-compact-cc-style`; eval closed #1836 (2026-08-23).

Housekeeping note (2026-08-23): folder retrofitted into house shape — it predates the map.md
convention; spec/plan/eval reports were in place but no map.

## Fog of war

- If A/B evidence ever shows hallucination pressure needing verify/repair, that is a
  data-backed follow-up effort (spec §Non-goals names it); none observed in batch 1–2.

## Cross-effort links

- **Shares-decision-with**: `.planning/2026-08-23-subagent-cc-parity-2` — both efforts import
  Claude Code behaviors into s2-agent behind measurable harnesses rather than wholesale ports.
