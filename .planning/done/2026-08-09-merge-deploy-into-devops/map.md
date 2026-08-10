---
status: complete
---
# Wayfinder map: 2026-08-09-merge-deploy-into-devops

## Destination

Consolidate the standalone `pi-agent-ext-deploy` extension **into** the
`pi-agent-ext-devops` extension. `deploy` is a 2-tool redundant subset of the
devops domain (build/verify/deploy of the pi-agent bundle), so it should live
alongside the other DevOps tools. After the merge the `deploy` package is
**deleted**, its single manifest entry is removed, and its only consumer
(`pi-agent-ext-tool-gate`, test-only) is rewired to reach the tools via devops.

## Notes

- **`deploy` (source):** 2 tools (`pi_deploy`, `pi_verify`), 0 skills, 0 commands.
  Files: `extensions/deploy.ts` (re-exports `src/index.ts` factory);
  `src/{index.ts,argv.ts,run.ts,deploy-tool.ts,verify-tool.ts}`;
  `src/*.test.ts` (4 unit) + `__tests__/e2e.test.ts` (`PI_AGENT_E2E=1`-gated).
- **`devops` (destination):** 7 tools + 1 skill (`skills/devops-workflow/SKILL.md`).
  Entry: `extensions/devops.ts` (INLINE tool registration, no `defineTool`).
  `src/*-recipe.ts` etc.; `tests/*.test.ts` (12).
- **Consumer:** `deploy`'s ONLY consumer is `pi-agent-ext-tool-gate` (test-only):
  devDep `@repo/pi-agent-ext-deploy`, used in `qa/evaluate.ts` +
  `extensions/drift-guard.test.ts`. `devops` is already a devDep there, so once
  the deploy tools register in the devops factory they are reachable via the
  existing `devopsDefault`/`devopsExtension` imports.
- **Registration:** both are DYNAMIC in `bun-apps/pi-agent/run-dir/manifest.json`
  (`extensions[]`); neither is static. schema-cost auto-discovers from the
  manifest (no manual edit; dropping the deploy entry drops its cost naturally).
- **Deps:** identical peer profile (`@earendil-works/pi-coding-agent@0.84.1`,
  `typebox:*`); `deploy` additionally declares `@types/bun` → add to devops for
  parity.

## Decisions so far

1. **Keep tool names** `pi_deploy` and `pi_verify` verbatim (so the tool-gate
   corpus probes + `findGate("pi_deploy")` keep resolving; no probe churn).
2. **Each tool keeps its OWN owner-declared gating keywords verbatim** — do NOT
   conflate with devops's PR/merge keywords (`build bundle`, `bundle pi-agent`,
   `pi-agent bundle`, `run-test` + the noun∧verb requires stay as-is).
3. **Add `@types/bun`** to devops `devDependencies` (parity with the deleted
   package's devDeps).
4. **Preserve the `PI_AGENT_E2E=1` gate** on the ported e2e test.

## Not yet specified

- None. The deploy factory (`src/index.ts`) + its `src/index.test.ts` are
  **dissolved**, not moved — the tool definitions port into `devops.ts` (matching
  its inline style), and the registration smoke test is subsumed by the updated
  `devops/tests/entry.test.ts`.

## Out of scope

- **Renaming** `pi_deploy` / `pi_verify` (would break the tool-gate corpus + any
  saved references).
- **Changing gating semantics** — keywords/`requires` stay byte-identical; the
  tools just change owning extension.
- Adding the deploy tools to drift-guard's `MIGRATED_EXTENSIONS` under a *new*
  devops row: devops itself was never drift-guarded (its `pr_status` is ungated),
  so the cleanest move is to drop the deploy row and let the tools ride with the
  rest of devops (consistent, no behavior change to other devops tools).
