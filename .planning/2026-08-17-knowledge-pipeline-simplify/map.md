---
status: active
---

# Knowledge pipeline simplify — 2026-08-17

## Destination

A locked simplification SPEC for the four knowledge-pipeline packages (pi-agent-ext-obsidian, pi-agent-ext-hermes-memory, pi-agent-ext-knowledge-card, pi-agent-core-interface): every cut/merge/keep decision resolved with structural-clarity acceptance criteria, ready for to-spec → to-tickets handoff. Plan, don't do — no code changes inside this map.

## Notes

- Domain: memory → knowledge layer. `bun-apps/KNOWLEDGE-LAYER.md` is the authoritative overview but its snapshot is 2026-07-14 — it PRE-DATES efforts #1556 (LeanRAG simplify) and #1571 (hierarchy port); claims may be stale.
- Facts (src+extensions LOC, 2026-08-17): hermes 30,805 · zk 7,899 · obsidian 6,854 · core-interface 1,011. Fat files: hermes memory-store 1916 / surreal-repo 1111 / sqlite-backend 1090 / sqlite-memory-repo 969 / sqlite-session-repo 852 / skill-store 828 / walk-and-ingest 814 / skills-command 745 / card-store 674 / memory-tool 559 / semantic-search 547; zk extensions/knowledge-card.ts 1175 / retrieve.ts 826 / adapters.ts 631.
- Protected dependency edges: hermes→zk via `@repo/pi-agent-core-interface` seam ONLY (dep-guard); zk→obsidian hard import; surreal default backend + sqlite fallback.
- Pinned surfaces (constraints, NOT levers): hermes 6-tool / ≤2100 schema tok; zk 4 tools (zk_card / zk_ask / zk_ingest / knowledge_query); hierarchy no-tree retrieval byte-identical (#1571 golden tests).
- Success criterion (user, 2026-08-17): STRUCTURAL CLARITY — fewer files/layers, zero dead code, docs match reality. LOC is incidental, not a target (effort-1 lesson: −40~50% LOC goal unmet at +0.1%).
- Skills every session consults: grilling, domain-modeling, codebase-design, research. Tickets 01–03 AFK; 04–06 HITL.

## Decisions so far

- [Charter — destination, scope, criterion](tickets/00-charter.md) — simplification spec; all four packages; structural clarity over LOC.
- [Docs drift census](tickets/01-docs-drift-census.md) — 3 high / 4 med / 1 low drift findings; surreal-default + dead peerDep story + tool-list omissions top the list.
- [Dead-code census](tickets/02-dead-code-census.md) — 0 DEAD modules in all four packages; ~704 LOC lives only behind zk's CLI tier; ~17 trivially dead.
- [Redundancy census](tickets/03-redundancy-census.md) — layering already healthy; ≈830 LOC total levers (CLI retirement + leaf hoists + trivia); cross-pkg redundancy ~0.
- [Collapse decisions](tickets/04-collapse-decisions.md) — integration polish one-effort; retire loop+merge+CLI; hoist leaves; sqlite keep.
- [Structure targets](tickets/05-structure-targets.md) — file count ≥ −3 · dead exports 0 · docs truthful · mirrors-must-hoist rule.
- [Risk boundary](tickets/06-risk-boundary.md) — formats/schemas/contracts/pinned surfaces untouchable; L1–L4 independent slices.

## Not yet specified

- (cleared — spec synthesized; see spec.md)

## Out of scope

- Package merging / re-tiering / renaming (user chose simplification, not architecture redraw).
- LOC hard targets (LOC is a byproduct here, never an acceptance number).
- Tool-surface or schema-cost reduction as a primary axis (pinned surfaces are constraints).
- New dependencies; behavior changes to shipped hierarchy retrieval (#1571 goldens).
