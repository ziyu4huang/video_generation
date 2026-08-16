# 03 — Gate the 3 ungated heavy tools

type: task

## Question

`qa:coverage` reports 3 heavy tools (≥300 tok/req) that no gate tracks — pure savings, no mechanism change:

```
389 tok  webui_present    [webui]
369 tok  planning_stale   [hermes-memory]
309 tok  knowledge_search [hermes-memory]
```

For each: either (a) owner-declare `gating` (keywords ± `requires`) on the tool's definition, or (b) confirm always-on by design with a written rationale. Then `bun run qa:coverage --strict` must pass (0 ungated heavy) and `bun run qa` must stay green (savings floor + L1 + gate-recall).

Note: if ticket 01 lands first, declare the new `gating` in whatever contract shape it produces. If 01 has not landed, use the current per-tool `gating` field.

## Acceptance

`bun run qa:coverage --strict` green; `bun run qa` green; each gated tool has must-fire + must-not-fire coverage in the corpus (or a documented always-on rationale).

blocked by: 01 (declaration shape may change)

## Post-sync note (origin/main `9c1f2ab8`)

Scope shrank upstream: `planning_stale` and `knowledge_search` (hermes-memory) now declare `gating: { core: true }` on origin/main — they are no longer "ungated heavy", they are **core** (so they belong to ticket 02's demotion set, not a new gate here). Only **`webui_present`** (~389 tok, webui) remains ungated. This ticket reduces to: gate `webui_present` (or confirm always-on), then `qa:coverage --strict` green.
