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

## Resolution

**Done**. The flip: root fields → `./src/index.ts`;
`publishConfig`/`files`/`prepublishOnly` deleted **plus `repository` + `author`** (upstream
QuintinShaw provenance — false for this fork under decision 01-b); `test` =
`check && test:unit` (biome check passes clean — the CI row's "formatting drift" note was
stale); tsconfig `outDir` removed; **pi-agent postinstall dist-presence heal deleted**
(scripts.postinstall removed entirely); CI matrix row → generic `bun run test`.

**Deviation from the ticket plan**: `workflow-command.test.ts`'s deep import
(`import("../../../../pi-agent-ext-workflow/src/index.ts")`) is KEPT — re-reading it, the
bypass exists to dodge the file's own `mock.module("@repo/pi-agent-ext-workflow", …)`, not
dist resolution; collapsing it to the bare specifier would route the "real module" loader
through the mock. Root→src makes the deep import semantically identical to the specifier;
comment already accurate, no edit needed.

Verification — all with `rm -rf bun-apps/pi-agent-ext-workflow/dist` in force:

- workflow canonical `bun run test`: **1078 tests / 0 fail** (7.5s, from src)
- pi-agent CLI consumers (`workflow-command` + `workflow-retrieval-quality`): 17 tests pass
- movie-director canonical `bun run test`: **895 tests / 0 fail** — the exact package that
  was un-loadable in the 2026-08-15 NameTooLong incident
- pi-agent cross-package typecheck: exit 0; `./pi-agent.sh -p`: `BOOT4OK`, zero stale
  warnings, and boot no longer runs the (deleted) postinstall heal

Ticket closed 2026-08-15.
