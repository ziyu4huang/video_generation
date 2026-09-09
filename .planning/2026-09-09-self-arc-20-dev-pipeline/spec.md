# Spec — self-arc-20 develop-pipeline sweep

Design contract for the five tickets. Map carries context + decisions; this
file pins the interface rules the tickets implement.

## Abstraction rule (D1)

A cross-package surface moves to the shared core when it is a **static
capability contract** (import-time types + resolution), and onto the `__pi*`
seam registry when it is **live process coordination** (runtime published
readers). This arc moves two static surfaces:

| Surface | Today | Target | Precedent |
|---|---|---|---|
| vision-LLM (`askImage`, `resolveVisionLLM`, `ResolvedLLM`) | `s2-agent-ext-file2md` src | `s2-agent-core-interface` leaf `vision-llm-leaf.ts`; file2md keeps the impl + back-compat re-exports | `embedding-leaf.ts` |
| repo/runpy paths (`resolveRepoRoot`, `resolveRunPyPaths`, `defaultBinaryPath`) | `s2-agent-ext-ltx` src | `s2-agent-core-runtime` `repo-paths.ts`; ltx re-exports | `home.ts` |

Consumers switch to the core package; the producing ext drops the runtime
dep only when no other import of it remains. Back-compat re-exports stay
until a dedicated rename/cleanup PR (rename-averse, D5).

## Gate rule (D3/D4)

New/changed gates follow the workspace-gate family contract: static source
analysis, grounded assertions (vacuous pass impossible), registered in
`bun-apps/package.json` scripts + `.github/workflows/ci.yml.disabled`
regression-gates (the runtime gate-list source), and born green — an
enforcing gate lands in the same change that cleans its baseline.

## Deploy-e2e rule (T05)

Probe budget knobs are explicit, validated, default-preserving, and SKIPs
carry structured receipts (budgetMs/observedMs/hint). A SKIP never reads as
pass.

## Out of scope (this arc)

Wire renames (PR #1738 pattern), movie-director's media-executor edges
(runFlux2/runKrea2/WorkflowManager — frontier T06), knowledge-card→obsidian
(TIER-0→TIER-1 downward, protected by dep-guard invariant 4), tool-gate's
estimateToolCost import (single small edge; revisit with T06).
