# 17 — docs closeout: CONTEXT/ADR/KNOWLEDGE-LAYER truth

- **Phase:** P4 · **Package:** cross (kcard, hermes, obsidian, bun-apps docs) · **Status:** closed 2026-08-30

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

## Resolution (2026-08-30)

Closed on `feat/kcard-t17-docs-closeout`:

- **kcard CONTEXT.md**: t07–t16 vocabulary added — card schema v2 (+ experience kind),
  tier ladder + demote-not-truncate, auto-recall injector (+ per-session child-guard),
  RecallLedger (retrieved ≠ served), used-ledger (used ≠ served ≠ accessed), hotness
  multiplier, memory diff (`.distill-diff.json`), retrieval-eval harness — each with
  `_Avoid_` disambiguations against the resource-tier "tier" and the recall-audit harness.
- **bun-apps/KNOWLEDGE-LAYER.md**: lifecycle view section (CAPTURE→CONVERGE→RETRIEVE→
  INJECT→FEEDBACK) at the top; hermes row corrected to capture-only (ADR-hermes-memory-0002,
  actual tool list `memory`/`search_memory`/`knowledge_search` lexical/`knowledge_ingest`/
  `skill_manage_help`); read-path table `memory_search`→`search_memory`; C2 marked ✅.
- **CONTEXT-MAP.md**: obsidian entry drops "opt-in semantic search" (retired t02).
- **hermes CONTEXT.md**: review-transport term fixed (spawnSubagent fallback; `pi -p`
  subprocess removed).
- **obsidian skills/using-obsidian-vault/SKILL.md**: semantic_search routing row marked
  RETIRED → `knowledge_query`.
- **ADR-knowledge-card-0001** (first kcard ADR): feedback measured-before-armed — used ≠
  served ≠ accessed is load-bearing; both levers default OFF with recorded unseeded
  re-arm triggers (D11/D12/D13).
- **Tickets 05/06/11**: `## Resolution` appended (t11's stale `Status: open` fixed — it
  closed 2026-08-29 in #2148); map `status: complete`, Frontier = QUEUE DRAINED with the
  four dormant triggers, D3 fog entry RESOLVED.

Retired-term sweep: obsidian README already documents the retirement; research-tool's
vault-mind references describe LIVE code (its import-memory lane) — out of this effort's
scope, noted for a future research-tool effort. kg-improvement-plan.md is a dated
planning snapshot — left as history. `bun run test:adr` 17 pass.
