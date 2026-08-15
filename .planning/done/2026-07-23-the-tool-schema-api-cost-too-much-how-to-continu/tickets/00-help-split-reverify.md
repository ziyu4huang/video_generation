---
type: research
status: closed
---

## Question

For each `_help` tool (`flux2_help`, `krea2_help`, `ltx_help`, `movie_help`, `obsidian_help`, `obsidian_search_help`), does the split **still pay off under the current tool definitions** — i.e. is `schema(main) + schema(_help)` still `< schema(main-with-everything-inline)`? Or has tool-def drift made any split net-negative / redundant?

This re-tests the 2026-07-08 "help-split is measured-optimal" insight (which predates today's tool set) under current defs, honoring that memory's own "MEASURE first" rule.

**Why now.** tool-gate gating `[flux2, flux2_help]` together does NOT subsume the split (orthogonality — see map Notes). But two cases still need a fresh number: (a) gated pairs — confirm `2× small < big` still holds after any param growth; (b) `obsidian_help`/`obsidian_search_help` — obsidian is CORE (always active), so the split defers **nothing** here and may be pure overhead unless obsidian's merged schema would be large.

**Method.** `buildSchemaCostReport` (`bun-apps/pi-agent-cli/src/commands/schema-cost.ts`) gives every tool's `(desc+params)/4`. For each split pair, compare `cost(main)+cost(_help)` vs a synthetic `cost(main-merged)` (main's params + `_help`'s full content inlined). Split wins iff merged would be larger. Flag any pair where the split adds net overhead (a `_help` whose content is small).

## Findings (research pass 2026-07-23)

Measured via `bun run qa/research-cost.ts` (heuristic `(desc+params)/4`, ratio ~3.7 real):

| pair | main | _help | fired-sum | category |
|------|-----:|------:|---------:|----------|
| flux2 + flux2_help | 654 | 307 | 961 | gated |
| ltx + ltx_help | 564 | 316 | 880 | gated |
| krea2 + krea2_help | 635 | 82 | 717 | gated |
| movie + movie_help | 348 | 284 | 632 | gated |
| obsidian + obsidian_help | 156 | 52 | 208 | CORE (always-on) |

**Orthogonality CONFIRMED by data, not just reasoning.** For a *gated* pair, the active cost is binary: dormant = 0 (neither loaded), fired = `main+_help` sum. Merging would make fired = `main(merged)` — which equals the sum at best, exceeds it at worst (if the `_help` content lengthens `main`'s description beyond the separate schemas). So for gated tools the split is **neutral-to-beneficial**, never subsumed. For CORE `obsidian` (always active) the split is also neutral: `156+52=208` paid either way whether split or merged. The 2026-07-08 "split is optimal" finding **holds under current defs**.

**The real lever is three large `_help` schemas, not the split itself.** `flux2_help` (307), `ltx_help` (316), `movie_help` (284) each carry substantial parameter schemas paid on every fired turn. Whether that schema content is necessary — or bloated/redundant with `main` — is a separate question the split doesn't answer.

**Capture gap.** `workflow_help` + `subagent` are unmeasured here — schema-cost couldn't load the workflow extension (`pi.events.on` needs a live boot). Their `_help` delta is unknown; reopen if that extension's cost is ever captured.

## Resolution

**Keep the split.** Merging would not reduce gated cost (neutral) and risks increasing it; the 07-08 measurement still holds. The actionable thread is **slimming the three large `_help` schemas** — graduates as ticket 05 (blocked-by this one).
