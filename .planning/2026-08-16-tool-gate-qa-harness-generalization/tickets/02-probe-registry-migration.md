# 02 — Migrate probe exports into the registry + derive the collector

type: task
claimed:
blocked by: 01

## Task

Assuming ticket 01 lands the `GATE_PROBES` registry (spec §2.1):

1. In each owning extension, replace the `__GATE_PROBES__` / named-const export with
   `GATE_PROBES["<id>"] = { gate, adversarial, controls, recallFloor? }`, declared
   beside the existing `GATE_DEFS["<id>"] = …` line. 12 extensions, every id:
   flux2, ltx, movie-director, krea2, file2md, research-tool (collect_videos +
   arxiv_search), zai-mcp, workflow, devops (pi_deploy, await_pr_merge, sweep_branches,
   local_ci, sync_repo, devops_retrospect, prepare_branch, verify_merge, main_health),
   hermes-memory (memory_supersede, skill_manage, session_search, knowledge_search,
   knowledge_ingest, planning_stale, grill_decision), knowledge-card (zk family),
   web-access, obsidian, wayfind.
2. Collapse `qa/collect-probes.ts` from 25 imports + 33-entry `ALL_PROBE_SETS` to
   `Object.values(GATE_PROBES)` (spec §2.2). The owning-extension imports remain
   only in `qa/evaluate.ts` (it still drives their registrars).
3. Delete every now-unused `__GATE_PROBES__` / named-const export and their import
   lines in `collect-probes.ts`.

**Acceptance**: `bun run qa --strict` byte-identical (gate-recall 32/32, savings
15,186 tok, L1 tallies, coverage 0 ungated); `bun test` green in all touched
packages; `collect-probes.test.ts` passes with the same probe count but no
signature-JSON check (ticket 03 removes that).

## Resolution

(open)
