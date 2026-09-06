---
effort: 2026-09-06-self-arc-3
created: 2026-09-06
last: 2026-09-06
status: done
---

# Wayfinder map: 2026-09-06-self-arc-3 — deploy self-heal + live-reload guarantee

## Destination

Post-#2193 loop round: keep the develop → deploy → drive loop self-sufficient
and prove the subagent registry's live-reload so the /agents manager's edits
are real (effective on the next spawn, no restart).

## Tickets (single branch, single PR)

| Ticket | Status | Summary |
|---|---|---|
| 01 deploy self-heal | done | `deploy/lib/workspace-links.ts` `repairWorkspaceLinks(bunAppsDir)` — the bun isolated linker's full-install runs rewrite `bun-apps/node_modules/@repo/*` with a root-layout target (dangling; recurred 19:10 during the #2193 merge gates after a manual 16:39 repair). deploy preflight now repairs before anything stats through them (verified live: 32 links repaired, deploy `0.10.0+g04ff658` green). 2 unit tests. |
| 02 live-reload pins | done | `agent-def-reload.test.ts`: spawn_subagent re-loads the registry per call (`?? loadAgentRegistry(runCwd)`), batch tool per batch, /agents manager reloads after CRUD — pinning so nobody "optimizes" it into a session cache. Finding: the host never injects `options.agentRegistry`; reload was already live by construction — now guaranteed. |
| 03 `--scenario reload` receipt | done | two foreground spawns through agentType hard-problem with an on-disk def rewrite BETWEEN: child 1 replies RELOAD-ONE, child 2 RELOAD-TWO (settled-screen marker match; the ↳-line-only match was too narrow — the deployed parent narrates the result in prose/code fence). Source AND deployed `current` PASS. |

## Receipts

`output/self-arc3-receipt-2026-09-06/`: post-merge smoke (dispatch, deployed,
childModelIsGlm53 ✓), reload source ✓, reload deployed ✓.

## Decisions

- D1: repair at the point of use (deploy preflight) rather than hunting the
  bun linker's path computation — self-healing beats root-causing an upstream
  linker layout choice we don't own; the learnings entry documents the shape.
- D2: reload proof via settled-screen marker (unique string exists only in
  the def file → child reply → transcript), not a file artifact — the child
  may skip side-effect steps; the reply is the direct observable.
