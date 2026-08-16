# Package-rename recon (read-only inventory) — FINAL

Renames (user decision):
1. `bun-apps/pi-agent-ext-core-runtime` → `pi-agent-core-runtime` (core lib, NOT an extension; no `extensions/` dir)
2. `bun-apps/pi-agent-ext-core-interface` → `pi-agent-core-interface` (core lib, NOT an extension; no `extensions/` dir)
3. `bun-apps/pi-agent-ext-core-task` → `pi-agent-ext-task` (stays extension; HAS `extensions/core-task.ts`)

## 1. Package identity
| pkg | package.json name | entry file | CLI subcommands |
|---|---|---|---|
| pi-agent-ext-core-runtime | `@repo/pi-agent-ext-core-runtime` (L2), main/types `./src/index.ts` | none (lib only) | none (no cli-subcommand.ts anywhere in 3 pkgs; `pi-agent/src/cli/extensions/registry.ts` has 0 core refs) |
| pi-agent-ext-core-interface | `@repo/pi-agent-ext-core-interface` (L2), exports `.types → ./src/types.d.ts` | none | none |
| pi-agent-ext-core-task | `@repo/pi-agent-ext-core-task` (L2) | `extensions/core-task.ts` | none |

## 2. Registration / wiring
- `pi-agent/run-dir/manifest.json` **L65** `staticExtensions[]`: `"pi-agent-ext-core-task"` (NOT in dynamic `extensions[]`; core-runtime/interface absent entirely).
- `pi-agent/src/static-extensions.ts` **L55** `import coreTaskExtension from "../../pi-agent-ext-core-task/extensions/core-task.ts"`, **L72** `{ name: "pi-agent-ext-core-task", factory: coreTaskExtension }`, **L44** comment.
- `pi-agent/run-dir/resolve.ts` L179-181 comments (bare dir names).
- `schema-cost.ts`: `EXTRA_ENTRIES = []` (L146); derivation is manifest-driven — `staticExtensions` → `bun-apps/<pkg>/extensions/<suffix>.ts`, `source = pkg minus pi-agent-ext-`. **⇒ after rename, source label changes `core-task` → `task`, path → `pi-agent-ext-task/extensions/task.ts`.** Baselines/fixtures hardcoding the label:
  - `pi-agent/baselines/schema-cost-baseline.json` L94, L256 (`"source": "core-task"`)
  - `pi-agent/src/cli/__tests__/__fixtures__/boot-smoke.baseline.json` L12
  - `pi-agent/src/cli/__tests__/schema-cost.test.ts` L216 (source list incl. `"core-task"`)
  - `pi-agent-ext-archify/ir/pi-agent-extensions.architecture.json` L11,14,18,44,58 + `__tests__/ext-architecture-ir.test.ts` L18, L32 (node id `core-task`, edge wayfind→core-task)
  - (unverified: `pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json` — referenced by archify receipts, likely lists `core-task`; root `scripts/schema-cost-baseline.json` similarly referenced)

## 3. Workspace dependents (package.json deps → `@repo/...`)
`@repo/pi-agent-ext-core-runtime` (rename to `@repo/pi-agent-core-runtime`):
- subagent L55; workflow L54; core-task L38 (self-dep of renamed pkg)

`@repo/pi-agent-ext-core-interface` (rename to `@repo/pi-agent-core-interface`) — 17 dependents:
- `bun-apps/package.json` L8 (workspace root!)
- pi-agent L63; movie-director L42; knowledge-card L29; workflow L67; obsidian L43; hermes-memory L68; subagent L67; power-tool L30; devops L33; krea2 L33; file2md L51; tool-gate L33; research-tool L37; wayfind L66; flux2 L34
- plus tsconfig `compilerOptions.types: ["bun","@repo/pi-agent-ext-core-interface"]` in: pi-agent/tsconfig L7, movie-director L8, workflow L7, obsidian L8, hermes-memory L22, subagent L7, devops L13, krea2 L8, file2md L7, core-runtime L7, research-tool L8, wayfind L7, flux2 L8
- triple-slash / value imports of the bare package: core-task/extensions/core-task.ts L1 (`/// <reference ...>`); power-tool/src/index.ts L1; tool-gate/extensions/tool-gate.ts L1; knowledge-card (src/* + __tests__/*, ~12 files); hermes-memory (src + tests, ~12 files)

`@repo/pi-agent-ext-core-task` (rename to `@repo/pi-agent-ext-task`):
- pi-agent L39; tool-gate L34 (+ **deep imports** `@repo/pi-agent-ext-core-task/src/...` in `tool-gate/qa/evaluate.ts` L74-76 and `tool-gate/extensions/migrated-extensions.ts` L19-21)

`@repo/pi-agent-ext-core-runtime` value consumers (imports, not just dep): workflow `src/**` (~20 files) + `tests/**` (~18) + `dist/*.d.ts` (~11, build artifacts); core-task `extensions/core-task.ts` L29 + `src/subagents/*` (6 files).

## 4. Relative-path imports that break on git mv (exact)
- `bun-apps/tests/seam-contract.test.ts` L54: `../pi-agent-ext-core-interface/src/index.ts` (+ comments L51, L62, L75, L80, L263)
- `pi-agent/src/static-extensions.ts` L55 (above)
- `pi-agent-ext-wayfind/tests/chain.test.ts` L5: `../../pi-agent-ext-core-task/src/plan/parse.ts` (+ `tests/plan-seed-contract.test.ts` L7 comment)
- `pi-agent-ext-tool-gate`: L74-76 / L19-21 (deep `@repo` subpaths above)

## 5. Test literals that must change
- `bun-apps/tests/dep-guard.test.ts` **L188-189**: parses `"@repo/pi-agent-ext-core-interface"` from a types-array fixture and `assert.deepEqual(..., ["pi-agent-ext-core-interface"])` — literal must become `pi-agent-core-interface`.
- `bun-apps/tests/ci-workflow-references.test.ts` L13, L511, L519 (prose references to pkg name); `package-scripts-runnable.test.ts` L15, L24, L185, L224, L232 (same).
- Baselines/fixtures listed in §2.
- `power-tool` uses widgetKey `"pi-core-task"` (index.test.ts L913-968) — **runtime widget key, NOT the package name — do NOT rename**.

## 6. Other files with the strings
- `bun.lock` (2254 lines; refs at L8, L57, L81, L117-118, L128-129, L135, L145-146 + more) — regen via `bun install` from `bun-apps/`, never hand-edit.
- Docs (update list): `bun-apps/docs/adr/INDEX.md` L49-59 (ADR links to `pi-agent-ext-core-{task,runtime}/docs/adr/...`); `bun-apps/docs/adr/0001-strict-downward-edges-knowledge-layer.md` L97, L101; `pi-agent/README.md` L199; `pi-agent/docs/deploy-single-binary.md` L30, L66, L84, L182; `pi-agent/docs/slash-commands-tools-skills.md` L81, L85; `pi-agent/docs/deploy-cwd-trust.md` L142; `pi-agent/docs/extension-dependency-tree.PRD.md` (L75-279, many); `pi-agent/src/workspace-dist-staleness.ts` L7 (comment); subagent README/CONTEXT/src comments use informal `core-runtime` (~40 sites, prose — optional).
- In-package: core-task `CONTEXT.md` L1/L7, `run-test.sh` L3,32,45,54,60 (tmpfile path), `docs/*.md` (historical dated docs — recommend leave as-is, they're archival); core-interface `src/types.d.ts` L1-9, `src/tool-gating.d.ts` L10-32 (comments/tsdoc).
- `.github/workflows/ci.yml.disabled` L141,146,147,152,596,610 and `.github/CI.md` L47,196,209-210 — CI disabled by design; update for consistency (cheap) or leave (flagged).
- `vaults_root/study-news/Zettelkasten/**` (~8 notes) — external knowledge notes, recommend skip.
- `.planning/**` counts only: `pi-agent-ext-core-runtime` 31 files/219 lines; `-core-interface` 37/220; `-core-task` 76/405 (short forms: core-task 151 files/915 lines; core-runtime 40/342; core-interface 42/323). Mostly historical tickets — recommend leave, flag in PR.
- `workflow/dist/**` — build artifacts; regenerate via `( cd bun-apps/pi-agent-ext-workflow && bun run build )`.
- `subagent/dist/**` — build artifacts; regenerate if subagent has a build gate.
- LaunchAgents/Makefiles/tsconfig paths/jest aliases: none found. gui-movie-director, perf-harness: no references (not dependents).

## 7. Canonical gates of affected packages (from CLAUDE.md rules; run each pkg's own scripts)
- wayfind: `bun run check && bun run typecheck && bun test` (check=biome; all three required)
- hermes-memory: `bun run check` (= tsc) + `bun test`
- workflow: `bun run build && bun test`
- pi-agent / pi-agent-cli: own `bun test` suites (schema-cost, boot-smoke fixtures live here)
- all other dependents (subagent, tool-gate, knowledge-card, movie-director, obsidian, devops, krea2, file2md, power-tool, research-tool, flux2) + the 3 renamed pkgs: canonical `bun run test`/`check` per package.json
- repo-wide: `bun-apps/tests` suite (dep-guard, seam-contract, ci-workflow-references, package-scripts-runnable live there)
- `bun run --cwd bun-apps/gui-movie-director check:schema` unaffected (no refs)

## 8. RENAME PLAN (safe order)
1. Branch per devops-workflow skill.
2. `git mv bun-apps/pi-agent-ext-core-runtime bun-apps/pi-agent-core-runtime`; `git mv bun-apps/pi-agent-ext-core-interface bun-apps/pi-agent-core-interface`; `git mv bun-apps/pi-agent-ext-core-task bun-apps/pi-agent-ext-task`.
3. `git mv bun-apps/pi-agent-ext-task/extensions/core-task.ts bun-apps/pi-agent-ext-task/extensions/task.ts` (repo rule: entry = folder minus `pi-agent-ext-`).
4. Edit the 3 package.json `name` fields → `@repo/pi-agent-core-runtime`, `@repo/pi-agent-core-interface`, `@repo/pi-agent-ext-task`.
5. Repo-wide string replace (exclude node_modules, `*/dist/*`, `.planning`, `vaults_root`, `bun.lock`):
   - `pi-agent-ext-core-runtime` → `pi-agent-core-runtime`
   - `pi-agent-ext-core-interface` → `pi-agent-core-interface`
   - `pi-agent-ext-core-task` → `pi-agent-ext-task`
   (this automatically fixes all `@repo/...` deps, tsconfig types arrays, triple-slash refs, manifest, static-extensions import+name, wayfind/tool-gate deep paths, dep-guard L188, docs.)
6. Entry-path literal `extensions/core-task.ts` → `extensions/task.ts` in: `pi-agent/src/static-extensions.ts` L55, `pi-agent/docs/deploy-single-binary.md` L66, `pi-agent/docs/slash-commands-tools-skills.md` L85, `pi-agent-ext-wayfind/docs/adr/0003...md` L15 (docs optional but cheap).
7. Source-label `"core-task"` → `"task"` (NOT a blind replace — only the schema-cost identity sites): `pi-agent/baselines/schema-cost-baseline.json` L94/L256, both `boot-smoke.baseline.json` fixtures (verify pi-agent-cli one), `schema-cost.test.ts` L216, archify `ir/*.json` + `ext-architecture-ir.test.ts` (node id + wraps/edges), `static-extensions.ts` L44 comment, `resolve.ts` comments, e2e comments.
8. `manifest.json` L65: `"pi-agent-ext-core-task"` → `"pi-agent-ext-task"` (covered by step 5).
9. `( cd bun-apps && bun install )` → regen `bun.lock` (isolated linker re-links the renamed pkgs).
10. Rebuild artifacts: workflow `bun run build`; subagent dist if it has a build script.
11. Gates (§7): 3 renamed pkgs + all 20 dependents, prioritized: pi-agent, pi-agent-cli (schema-cost + boot-smoke), bun-apps/tests, workflow, subagent, tool-gate, wayfind (3 gates), hermes-memory, knowledge-card, archify.
12. Optional consistency sweep: `.github/CI.md`, `ci.yml.disabled`, `docs/adr/INDEX.md` links, `bun-apps/docs/adr/0001...` — do INDEX.md at minimum (it links real files).
13. PR + local CI + `gh ship` (devops chain; remote CI disabled by design).

## 9. Flags / could not fully classify
- `pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json` and root `scripts/schema-cost-baseline.json` — cited by archify receipts; direct verification aborted at budget. MUST check before executing step 7.
- `.planning/**` (915 lines for short form `core-task`) — historical, recommend leave; note in PR body.
- `vaults_root` zettelkasten notes — external, skip.
- power-tool `"pi-core-task"` widgetKey — deliberate runtime key, NOT renamed (mislabel risk).
- `workflow/dist`, `subagent/dist` — regenerate, don't hand-edit.
- subagent informal `core-runtime` prose (~40 sites) — rename optional; code refs are all `@repo/...` (covered by step 5).
