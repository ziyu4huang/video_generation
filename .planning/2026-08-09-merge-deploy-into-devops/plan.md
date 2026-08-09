# Wayfind — merge deploy into devops — 2026-08-09

## Context

`pi-agent-ext-deploy` (2 tools: `pi_deploy` + `pi_verify`) is a redundant subset
of the devops domain. Consolidate it INTO `pi-agent-ext-devops`, then delete the
deploy package + its manifest entry + its tool-gate devDep. The 4 decisions in
`map.md` govern: keep tool names, keep each tool's own gating keywords verbatim,
add `@types/bun` to devops, preserve the `PI_AGENT_E2E=1` gate.

## Tasks (T1..T9)

- **T1 — move deploy code + tests into devops** (`git mv`).
  Files: `deploy/src/{argv,run,deploy-tool,verify-tool}.ts` →
  `devops/src/{deploy-argv,deploy-run,deploy-tool,verify-tool}.ts`;
  `deploy/src/{argv,run,deploy-tool,verify-tool}.test.ts` →
  `devops/tests/{deploy-argv,deploy-run,deploy-tool,verify-tool}.test.ts`;
  `deploy/__tests__/e2e.test.ts` → `devops/tests/deploy-e2e.test.ts`.
  Update INTERNAL imports (`./argv` → `./deploy-argv`, `./run` → `./deploy-run`;
  test `./x.ts` → `../src/deploy-x.ts`). Keep peer imports as-is. Preserve
  `PI_AGENT_E2E=1`. `src/index.ts` + `src/index.test.ts` + `extensions/deploy.ts`
  are DISSOLVED (factory ports into devops.ts).
  **Verify:** files present at new paths; no stale `./argv`/`./run` imports.

- **T2 — register pi_deploy + pi_verify in devops** (`extensions/devops.ts`).
  Port both tool definitions + their EXACT gating keywords INTO the devops
  factory, `import { runDeploy } from "../src/deploy-tool.js"` +
  `runVerify` from `verify-tool.js`. Match devops.ts's inline
  `pi.registerTool({...})` style (no `defineTool`).
  **Verify:** `devops/tests/entry.test.ts` updated; `bun test` in devops green.

- **T3 — remove deploy from manifest** (`pi-agent/run-dir/manifest.json`).
  Delete the `pi-agent-ext-deploy` entry block. Leave devops entry intact.
  **Verify:** `grep pi-agent-ext-deploy manifest.json` → nothing.

- **T4 — update tool-gate (only consumer)** (`pi-agent-ext-tool-gate/`).
  - `package.json`: remove `"@repo/pi-agent-ext-deploy"` devDep (devops already
    present).
  - `qa/evaluate.ts`: remove `deployDefault` import + its slot in
    `captureOwnerDeclaredDefs([...])` (the tools now ride via `devopsDefault`).
  - `extensions/drift-guard.test.ts`: remove `deployExtension` import + its
    `MIGRATED_EXTENSIONS` row (devops was never netted; dropping the row keeps
    parity, no behavior change to devops's other tools).
  **Verify:** `( cd pi-agent-ext-tool-gate && bun run check && bun test )` green.

- **T5 — devops ci-recipe fixture** (`tests/ci-recipe.test.ts`).
  Replace the `pi-agent-ext-deploy` fixture references (the "marked-false → not
  run" case) with a package that still exists, keeping the test's intent.
  **Verify:** `bun test` in devops green.

- **T6 — regenerate lockfile** (`bun install --cwd bun-apps`).
  Drops the deploy workspace entries.
  **Verify:** `grep pi-agent-ext-deploy bun-apps/bun.lock` →
  `DEPLOY-GONE-FROM-LOCK`.

- **T7 — delete the deploy package** (`git rm -r pi-agent-ext-deploy`).
  **Verify:** `git status` shows the deletion staged.

- **T8 — docs.** Append `pi_deploy` + `pi_verify` to `devops/README.md`; merge
  `deploy/CONTEXT.md` into `devops/CONTEXT.md` (create devops CONTEXT.md);
  mention the build/verify tools in `skills/devops-workflow/SKILL.md`.
  **Verify:** doc render / spot-read.

- **T9 — local CI (must be GREEN).**
  `( cd pi-agent-ext-devops && bun run check && bun test )`,
  `( cd pi-agent-ext-tool-gate && bun run check && bun test )`,
  `( cd pi-agent && bun test )`. Iterate until green.

## Out of scope

Renaming tools; changing gating semantics; re-enabling remote CI.

## Verification (final)

- `grep -rn "pi-agent-ext-deploy" bun-apps --include=*.json --include=*.ts --include=*.toml | grep -v node_modules` → nothing.
- `git diff --stat origin/main..HEAD` scoped to the in-scope paths.
