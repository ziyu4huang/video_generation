Arc-25 planning is complete. Final report:

## Deliverable

- **`.planning/2026-09-14-self-arc-25-pi-upgrade-subagent/map.md`** — canonical wayfinder map (house shape, frontmatter `status: active` matching ledger 25): Destination · measured Context · Scope IN/OUT with rejection reasons · tickets t01–t07 with file surfaces, tests, and per-ticket deployed-verification contributions · Decisions D1–D10 · Frontier · Fog of war · successor next-goal sketch · cross-effort links.
- **`.planning/2026-09-14-self-arc-25-pi-upgrade-subagent/plan.md`** — adjudication cover: gap-by-gap verdict table with evidence anchors, ticket-set summary, learnings/PB citations.
- **Commit: `001baf83`** on branch `self-arc-25-pi-upgrade-subagent` (base `6c3c400f`). Arc-ledger guard green (13/13).

## Ticket set

| Ticket | Content | Exit shape |
|---|---|---|
| t01 (P0, lands FIRST alone) | 29 package.json pins 0.84.4→0.85.1, lockfile recompute, full local-ci every package, byte-assertion sweep, setModel audit, zai/glm-5.3 list+smoke, version-bump at merge | all gates green + smoke receipt |
| t02 (P1) | 50KB child-output cap at parent-visible boundary in both tools; full text in `details` + durable record; grep-able marker (t06's bundle target) | boundary-matrix tests |
| t03 (P1) | ctx.cwd probe FIRST (child cwd ≠ parent cwd, read/bash on 0.85.1), then delete `agent.ts:361` re-binding or documented no-op | probe evidence committed either way |
| t04 (P2) | project-agent trust gate: project-source + untrusted + hasUI → confirm; no-UI → default-DENY naming file | matrix tests + t06 scratch-repo deny receipt |
| t05 (P2) | per-message usage ledger — land only if ≤ one seam | else dated REJECT w/ probe note |
| t06 | pinned deploy (PB-08), pre-drive bundle greps + core-cache MISS check, scratch-repo isolation, GLM-5.3-only scenarios a–d | receipts → `evidence/` |
| t07 | Shipped-as + status flip same PR (PB-05), ledger mergedPr, effort-audit, successor next-goal strict v2 | exit-0 gates |

## Planner-verified findings that shaped the plan

- **Output path measured unbounded** (`subagent-tool.ts:733`, `renderBatchResult` slot bodies) — t02 is real, not speculative.
- **`agent.ts:358-361` cwd re-binding is exactly the workaround 0.85.1 may obsolete** — t03 is verify-then-simplify with an honest no-op exit (arc-24 t04 pattern).
- **Trust gate gap confirmed**: registry loads project `.pi/agents` freely; `ctx.isProjectTrusted()` + `ui.confirm` already exist in the installed d.ts — added as t04 beyond the candidate list (digest §3 gap-3).
- **zai.json measured BYTE-IDENTICAL** 0.84.4↔0.85.1 (from the research tarballs) — de-risked t01(d) to a smoke, not a port.
- **N/A risk classes measured dead on arrival**: root-only imports, no pi-tui/theme/prompt-cache references, no write-tool byte assertions in our tests, presets' TRANSIENT BY CONTRACT already matches 0.85 semantics.

**Learnings applied**: #1 (t06 greps shipped bytes + cache-MISS check), #2 (bun-install window + self-heal backstop); **PB**: 01/02 (tip + ledger verified), 05, 08–11, 13–15, 17, 18 — each cited at its point of use in the map.