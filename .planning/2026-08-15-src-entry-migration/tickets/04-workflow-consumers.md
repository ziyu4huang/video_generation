type: task
blocked by: 03-superpowers-wayfind

## Question

Migrate `pi-agent-ext-workflow` — the risky one: it is the only one of the four with live
cross-package bare-specifier consumers of its root (the stale-dist blast radius).

Consumers that start resolving to src automatically (verify each after the flip):

- `bun-apps/pi-agent/src/cli/commands/workflow.ts:32` — `runWorkflowScript`, `listWorkflows`,
  `findRepoRoot`
- `bun-apps/pi-agent/src/cli/commands/memory-to-vault.ts:21` — `runWorkflow`
- `bun-apps/pi-agent/src/cli/__tests__/workflow-retrieval-quality.test.ts:2`
- `bun-apps/pi-agent-ext-movie-director/src/movie-manager.ts:17-18` (+ its 3 root-importing
  tests) — the exact graph from the 2026-08-15 NameTooLong incident
- `bun-apps/pi-agent/src/cli/__tests__/workflow-command.test.ts:52-59` — deliberate
  src-bypass import with the "bypasses package-name resolution" comment: collapse back to the
  plain bare specifier and delete the comment.
- Deep imports via `./extensions/*` and `./src/*` subpaths (tool-gate ×3) — unaffected, confirm.

Also remove now-dead scaffolding:

- `bun-apps/pi-agent/package.json:22` postinstall dist-presence heal for workflow.
- Publish-side fields per ticket 01's decision.
