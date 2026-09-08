# t04 — first qualify-driven deployed sweep + close-out

**status: blocked on t01–t03** · chain: devops-workflow end to end

## Steps

1. One implementation PR carrying t01+t02+t03 (+ D8 rider: `.distill-state.json.tmp`
   gitignore line). Gates per touched package: `s2-agent-ext-subagent`,
   `s2-agent-ext-devops`, `s2-agent-ext-ultracode` — each package's canonical
   `bun run check`/typecheck/test, schema-cost +0. Merge via merge-pr-after-ci; never
   wait on remote CI.
2. sync-default-branch → redeploy → verify the deployed tree (learning 1: grep the
   DEPLOYED artifact for a qualify-era symbol if anything looks stale; version label ≠
   content). Post-deploy boot smoke PASS.
3. **The first non-ad-hoc sweep**: `bun …/scripts/qualify.ts --sh <deployed>/s2-agent.sh
   --concurrency 3 --rpc-pair` → all 10 scenarios. Boot gate + receipts with arc-12/13
   discipline; wf-pause snaps show t03's corrected notification line.
4. Commit the GENERATED table to `.planning/2026-09-06-self-arc-14/results/sweep.md`
   (+ .json). Receipts stay under `output/` — never committed.
5. Docs close-out PR: map `status: shipped`, `last:` bumped, Frontier/Fog resolved
   (import-vs-port outcome, pause seam location, rpc probe cost), Cross-effort links
   reciprocal line in arc-13's map.
6. Successor next-goal (strict v2, validated, `output/LATEST-next-goal.md` repointed).
   Standing successor candidates to rank there: true first-keypress→settle retiming
   inside tui-drive (D1's queued half — additive + receipt-gated); rpc lane for recovery
   passes (learning 6's CLI-twin pattern); remaining dormant items.
7. Memory updated per session close-out SOP.

## Done when (arc Definition of Done)

- [ ] qualify.ts merged + allowlisted; gates green everywhere; schema-cost +0
- [ ] Full 10-scenario sweep on the redeployed tree driven BY qualify.ts: 10/10 green,
      table committed to the map, rpc cross-check cells present
- [ ] t03 fixed with unit seam tests + corrected line visible in the deployed wf-pause receipt
- [ ] Docs close-out PR merged; successor next-goal validated; memory updated
