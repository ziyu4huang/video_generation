# t05 — one PR, deployed receipts, sweep re-run, close-out

## Steps

1. One feature branch off synced main; all of t01–t04 (descoped as needed)
   land as ONE PR.
2. Gates before push, per touched package (`s2-agent-ext-subagent`,
   `s2-agent-ext-devops`, `s2-agent-ext-ultracode` if the repaint fix lands):
   `bun run check` + `bun test` + `bun run typecheck` (biome lints on
   appended code bounce the gate). Verify `bun scripts/check-schema-cost.ts`
   stays +0 (D5: no description strings changed).
3. Devops chain: PR → `merge-pr-after-ci` → sync main → redeploy →
   `verify-deploy-e2e` green.

## Deployed receipt legs (on the redeployed version dir)

- t01: `--scenario wf-pause` — all latched checks pass.
- t02: dispatch receipt with `--expect-model` (inheritance latch) +
  `grep -c getMainModel <versionDir>/s2-agent.js` ≥ 3 (artifact, not label).
- t04 (if kept): agents scenario latch shows builtin pack names.
- Full qualification sweep: re-run ALL scenarios (now nine: dispatch,
  parallel, viewer, agents, reload, swarm, catalog, workflow, wf-pause) —
  viewer/registry changes demand it; run anyway even if only scripts changed.

## Close-out

- Update this map (status → done, Shipped-as, sweep table); docs close-out
  PR per the one-arc rule.
- Hands-off rule: write the successor `output/next-goal-<ts>.md` BEFORE
  reporting done (using-s2-agent-skills route-first gate).
