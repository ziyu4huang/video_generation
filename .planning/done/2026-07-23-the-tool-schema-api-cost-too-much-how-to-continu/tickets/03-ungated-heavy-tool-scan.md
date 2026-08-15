---
type: research
status: closed
---

## Question

Are there **ungated heavy tools** (not in any `GATES` group, not in `CORE_TOOLS`) whose schema cost is large enough to warrant a new gate? Tools outside both CORE and GATES are always active (tool-gate fails open). Any heavy always-on tool is untaxed suppression headroom.

**Method.** Run `buildSchemaCostReport`; list every tool NOT in `CORE_TOOLS ∪ GATES.names`; sort by token cost descending; flag any above a threshold (e.g. >150 tok). Cross-check against `pi-agent-cli/src/commands/schema-cost.ts` `EXTRA_ENTRIES` (unregistered measure-worthy files the canary already knows about).

**Gateability constraint.** A candidate only becomes a new `GATES` entry if its trigger is keywordable **without false-fires** — the verify-map's L1 corpus discipline (must-fire / must-not-fire / escape probes). A heavy tool with no clean keyword stays ungated; record it and the reason.

## Findings (research pass 2026-07-23)

Measured via `bun run qa/research-cost.ts` — ungated tools (not CORE, not in any GATE), sorted desc:

| tok | name | source | flag |
|----:|------|--------|------|
| 536 | `cost` | movie-director-cost | ⚠ heavy |
| 311 | `arxiv_fetch2md` | research-tool | ⚠ heavy |
| 257 | `arxiv_search` | research-tool | ⚠ heavy |
| 93 | `arxiv_paper` | research-tool | — light |
| 52 | `skill_manage_help` | hermes-memory | — light |

**Three ungated heavy tools = 1,104 tok always active = 12.5% of the 8,834 active cost.** This is the single largest lever in the whole map — bigger than every gate except flux2. They are loaded (movie-director-cost + research-tool extensions register them) but tool-gate has no GATE for them, so they tax every request unconditionally.

**Keywordability (preliminary).**
- `cost` — movie-production cost estimation. Narrow domain noun; likely keywordable (`cost`, `budget`, `報價`, `成本`, `預算`) but risks false-fires on generic "cost" (e.g. "what's the cost of…"). Needs the co-occurrence `requires` pattern (noun ∧ domain verb) like the core-noun gates.
- `arxiv_fetch2md` / `arxiv_search` — academic-paper retrieval. Clean keyword (`arxiv`, `paper`, `論文`, `fetch paper`), low false-fire risk — the verify-map's research-tool gate already keywords `bilibili`/`youtube`; arxiv is the same shape.

## Resolution

**High-ROI gate candidates found.** The keep/pursue decision graduates as ticket 04: add a gate (or extend the existing research-tool gate) for `arxiv_*`, and a co-occurrence gate for `cost`. Expected saving ≈ 1,104 tok/req (−12.5% of active, on top of tool-gate's 39.9%). Keywordability for `cost` needs L1 probe authoring per the verify-map discipline.
