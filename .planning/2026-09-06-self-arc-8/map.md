---
effort: 2026-09-06-self-arc-8
created: 2026-09-07
last: 2026-09-07
status: done
---

# Wayfinder map: 2026-09-06-self-arc-8 — agentType catalog surfaces to the parent router

## Destination

Close the top remaining Claude-Code-parity gap found by surveying
ext-subagent against CC's subagent system and ultracode: CC's Task tool
description ENUMERATES the available subagent types, so the routing model
can pick one by description; s2-agent's `spawn_subagent.agentType` named
only the two built-ins — silently undercutting the registry CRUD +
live-reload work (a freshly created type was invisible to the router unless
the user typed its name into the prompt).

## Shipped

- **`agent-type-catalog.ts`** (ext-subagent): `buildAgentTypeCatalog(cwd)`
  renders "Available agentTypes: <name> — <desc>; …" from the SAME registry
  `agentType` resolves against (project > pack > user > builtin). Caps:
  12 entries / 700 chars / 120 per entry (≈+320 tokens ≈ +1.26% on the
  25k schema-cost baseline — gate green; baseline snapshot refreshed in
  the same PR per the intended-inflation rule).
- **Wired at tool-creation time** into `spawn_subagent` AND
  `list_subagents` descriptions (catalog is a boot-time snapshot —
  deterministic for CI because `.pi/agents/hard-problem.md` is committed;
  live-reload spawn semantics unchanged). Injectable
  `agentTypeCatalog` option for tests/embedders.
- **F-actor fix**: a TYPED singular dispatch now carries the agentType name
  into the in-flight entry's `agent` — the row actor used to fall back to
  `general-purpose` even while the def's prompt visibly ran (found LIVE by
  the first catalog receipt: the parent routed correctly, but the receipt's
  row-shape check couldn't see it). Source-pinned.
- **`--scenario catalog`** (tui-drive): the dispatch prompt NEVER names the
  type; the parent must pick it from the catalog by description. Routed
  evidence = `bg ● hard-problem glm-5.3` on one row (F-actor-fixed) or the
  child's streamed def-prompt quote. Required: backgroundRow, catalogRouted,
  settled, childModelIsGlm53.

## Tickets

- [x] t01 — catalog builder + unit tests (order, caps, determinism, wiring)
- [x] t02 — description wiring (both spawn tools) + F-actor data fix
- [x] t03 — schema-cost refresh + `--scenario catalog` receipt (source PASS;
      deployed PASS post-merge)

## Findings

- The parent (glm-5.3) routes by catalog semantics unprompted: from
  "Deep analysis on hard problems — bound to the big model." it picked
  `hard-problem` with zero name hints in the prompt (receipt:
  `output/self-arc8-receipt-src2-20260907/`).
- Receipt-design lesson (again): write the check from the RENDERED TRUTH,
  not the intended shape. The first run failed because the row regex
  assumed the actor name was carried — it wasn't (F-actor); the feature
  worked, the observation model was wrong. The fix order that worked:
  (1) fix the data defect the receipt exposed, (2) re-run the SAME receipt.
- Claude-Code/ultracode parity ledger after this arc (for ranking next):
  Task tool + custom agents + /agents CRUD ✓, background + notification +
  wait/stop ✓, parallel batch + swarm ✓, fork ✓, worktree isolation ✓,
  startup-context ✓, builtin read-only types ✓, catalog visibility ✓ (this
  arc). Remaining candidates: modelSeg live-slot staleness (`default`
  mid-run, fog-of-war), pack-definition visibility in /agents, swarm-abort
  variant, unified agents surface across ext-subagent in-flight registry +
  ultracode workflow panel (deep integration, big).

## Receipts

- source: `output/self-arc8-receipt-src2-20260907/` — 7/7 PASS
  (catalogRouted true at snap-04; 13 snaps, early break).
- deployed `0.10.0+ge7e2443`: `output/self-arc8-receipt-deployed-20260907/`
  — 7/7 PASS, catalogRouted true by snap-03 (7 snaps, early break); the
  deployed bundle carries the catalog template (grep on
  `ext/subagent/ext.cjs`).

## Shipped-as

PR #2199 merged CLEAN (squash `e7e24435`); main synced; redeployed;
deployed receipt green. One merge-gate bounce (biome useTemplate warning +
test-file format in the PR diff — fixed in the style commit); the
esc-settle-detector `useRegexLiterals` warning seen locally is pre-existing
on main and exits 0 (non-blocking noise from a newer biome).
