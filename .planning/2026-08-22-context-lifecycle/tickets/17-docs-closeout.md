# 17 — docs closeout: CONTEXT/ADR/KNOWLEDGE-LAYER truth

- **Phase:** P4 · **Package:** cross (kcard, hermes, obsidian, bun-apps docs) · **Status:** open

## Problem

The rethink changes three packages' surfaces; docs must tell the truth at close (and the
docs-minimalism policy — code comments > md, only CONTEXT/ADR/deploy/README-slim stay —
means we UPDATE the canonical few rather than add new pages).

## Approach

1. `bun-apps/KNOWLEDGE-LAYER.md`: two-tier → lifecycle view (capture→…→feedback), vault-mind
   gone, hermes capture-only, single retrieval path, injection loop.
2. CONTEXT.md updates: kcard (new terms: tier ladder, RecallLedger, usage ledger, hotness,
   ExtractLoop gray zone, card schema v2, experience kind — each with `_Avoid_` lines),
   hermes (capture-only vocabulary; retired terms marked), obsidian (semantic_search gone).
   CONTEXT-MAP.md entries unchanged (contexts already registered).
3. ADRs: hermes fold ADR lands with ticket 03 — here only verify; add a kcard ADR ONLY if
   the card schema v2 / injection-loop decisions meet the bar (hard to reverse + surprising
   + real trade-off) — likely yes for "per-turn injection after stealth-trim" (D7).
4. Map closeout: statuses, Frontier cleared note, final baselines table, `## Resolution`
   appended to every ticket.
5. `bun run test:adr` + artifact-leak guard green; no new docs beyond the canonical set.

## Acceptance

- All three CONTEXT.md files reflect reality (spot-check: no retired term presented as
  live); ADR index resolves; `bun run test:adr` green.
- Map status → complete; every ticket has `## Resolution`.

## Verification

`bun run test:adr` (from bun-apps/), grep for retired terms (`vault-mind`, `semantic_search`
as live surface, hermes "semantic recall") across bun-apps md files.
