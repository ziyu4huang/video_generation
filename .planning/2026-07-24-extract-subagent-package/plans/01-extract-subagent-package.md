# Extract pi-agent-ext-subagent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the subagent subsystem (engine + `subagent`/`subagent_runs` tools + data layer) out of `pi-agent-ext-workflow` into a new lower-dependency package `pi-agent-ext-subagent` that owns its own pi extension; migrate `knowledge-card` onto it; keep behavior byte-identical.

**Architecture:** Two packages, one-directional dependency `pi-agent-ext-workflow → pi-agent-ext-subagent`. The new package owns `spawnSubagent` + `WorkflowAgent` runner + the two LLM tools + in-flight/run-persistence (exposed as process-wide singletons so the workflow-side `/subagents` viewer reads the same instance). The TUI glue (`subagent-viewer`, `subagents-command`, `display`) stays in workflow because `display.ts ⟹ workflow.ts` (moving it would cycle).

**Tech Stack:** Bun workspace (`bun-apps/`), TypeScript (`NodeNext`/`tsc` → `dist/`), Biome, `@earendil-works/pi-coding-agent` 0.82.0 + `pi-tui` 0.82.0 + `typebox`. Pi extension via `static-extensions.ts` (relative `.ts` import, survives `bun build --compile`).

## Global Constraints

- **Working location:** implement in the current worktree directly (in-place, no separate worktree). Repo is currently detached HEAD with pre-existing dirty files — commit ONLY this plan's own changes (scoped `git add <path>`); never `git add -A`.
- **Shell discipline:** never top-level `cd`. Use `( cd bun-apps/<pkg> && ... )` subshells or `--cwd`. `no-cd-drift.sh` blocks top-level `cd`.
- **Workspace root:** `bun-apps/`. Run `bun install` from `bun-apps/`, never repo root. Add deps with the package's own `package.json` (workspace:*).
- **Cross-package import specifier for shared singletons:** workflow MUST import the in-flight/persistence singletons via the **src subpath** `@repo/pi-agent-ext-subagent/src/index.js` (NOT the dist root) so they resolve to the same module instance the subagent extension uses (`../src/...`). Other subagent symbols may use the root.
- **Behavior unchanged:** pure structural refactor. No public signature changes to `spawnSubagent` or `WorkflowAgent.run`. Existing tests are the safety net — they must stay green at every commit.
- **CLAUDE.md extension rules:** new package registers at exactly `extensions/subagent.ts`; add to `pi-agent/src/static-extensions.ts` (NOT `run-dir/manifest.json`) to avoid double-registration; static-extensions are auto-measured by the schema-cost canary (no manual `EXTRA_ENTRIES`).
- **Build before tests:** every package's `dist/index.js` must be built (`bun run build`) before consumers' tests import it. New package mirrors workflow's `boot-smoke` build expectation.

---

## File Structure

### New package `bun-apps/pi-agent-ext-subagent/`

| File | Responsibility |
|---|---|
| `package.json` | `@repo/pi-agent-ext-subagent`, runtime deps 0, peer pi-coding-agent/pi-tui/typebox, exports `.`+`./src/*`+`./extensions/*`, `pi.extensions: ["extensions/subagent.ts"]` |
| `tsconfig.json` | mirror workflow (NodeNext, rootDir src, outDir dist) |
| `biome.json` | mirror workflow |
| `.gitignore` | mirror workflow (`node_modules/ dist/ .pi/ ...`) |
| `src/spawn-subagent.ts` | public `spawnSubagent` + types (moved) |
| `src/agent.ts` | `WorkflowAgent` runner (moved) |
| `src/agent-history.ts` · `agent-registry.ts` · `errors.ts` · `model-tier-config.ts` · `sdd-report.ts` · `structured-output.ts` | engine support (moved) |
| `src/git-scope.ts` · `worktree.ts` · `home.ts` | leaf primitives (moved) |
| `src/config.ts` | **split** — only `MODEL_TIERS_FILE` + `AGENTS_DIR` (moved symbols) |
| `src/subagent-tool.ts` · `subagent-runs-tool.ts` | the two LLM tools (moved) |
| `src/subagent-run-persistence.ts` · `subagent-in-flight.ts` | data layer + **new** singleton accessors |
| `src/index.ts` | public API barrel |
| `extensions/subagent.ts` | **new** — registers `subagent`+`subagent_runs`, owns singletons, session_start capture |
| `tests/*.test.ts` | moved tests (15 files) + needed helpers |
| `README.md` · `CONTEXT.md` · `docs/adr/0001-why-extracted.md` | docs |

### Modified in `bun-apps/pi-agent-ext-workflow/`

- `src/` — 16 module files + 15 tests DELETED (moved).
- `src/index.ts` — moved-symbol exports become re-exports `from "@repo/pi-agent-ext-subagent"`.
- `extensions/workflow.ts` — drop subagent tool creation/registration; singletons imported from new pkg (src subpath).
- `package.json` — add `"@repo/pi-agent-ext-subagent": "workspace:*"`.

### Modified elsewhere

- `bun-apps/pi-agent/src/static-extensions.ts` — register subagent extension before workflow.
- `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` + `package.json` — depend on new pkg, drop workflow dep.
- `bun-apps/pi-agent-cli/src/__tests__/boot-smoke.test.ts` — add `buildIfMissing("pi-agent-ext-subagent", ...)`.

---

## Task 1: Scaffold the `pi-agent-ext-subagent` package

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `src/index.ts`
- Test: `( cd bun-apps/pi-agent-ext-subagent && bun run build )` produces `dist/index.js`

**Interfaces:** Produces a resolvable workspace package `@repo/pi-agent-ext-subagent` that builds an empty barrel.

- [ ] **Step 1: Create `package.json`**

Create `bun-apps/pi-agent-ext-subagent/package.json` (mirror workflow; runtime deps 0; acorn NOT included — that's workflow-only):

```json
{
  "name": "@repo/pi-agent-ext-subagent",
  "version": "0.1.0",
  "private": true,
  "description": "Isolated single-subagent dispatch for Pi — spawnSubagent + WorkflowAgent runner + subagent/subagent_runs tools. Extracted from pi-agent-ext-workflow as a lower-dependency library.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "publishConfig": { "access": "public" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./src/*": "./src/*",
    "./extensions/*": "./extensions/*"
  },
  "files": ["dist/", "extensions/", "src/", "README.md"],
  "scripts": {
    "test": "bun run check && bun run build && bun run test:unit",
    "test:unit": "bun test",
    "check": "biome check .",
    "format": "biome format --write .",
    "lint": "biome lint .",
    "build": "bunx tsc",
    "dev": "tsx src/index.ts",
    "prepublishOnly": "bun run build"
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "subagents", "multi-agent", "ai-agents", "agents", "isolated-context", "spawn-subagent"],
  "pi": { "extensions": ["extensions/subagent.ts"] },
  "license": "MIT",
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-tui": "0.82.0",
    "typebox": "*"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.16",
    "@earendil-works/pi-ai": "0.82.0",
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-tui": "0.82.0",
    "@types/bun": "^1.3.14",
    "tsx": "latest",
    "typebox": "^1.3.7",
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `biome.json`, `.gitignore`**

`tsconfig.json` (identical to workflow's):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "types": ["bun"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

`biome.json` (identical to workflow's):
```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.16/schema.json",
  "files": { "includes": ["**", "!dist", "!node_modules", "!.pi", "!samples"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "linter": { "enabled": true, "rules": { "recommended": true, "suspicious": { "noExplicitAny": "off" } } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" } }
}
```

`.gitignore` (identical to workflow's):
```
node_modules/
dist/
.pi/
.env
.DS_Store
*.log
.hermes/
*.test-quality-report.md
__pycache__/
.context/
```

- [ ] **Step 3: Create empty barrel `src/index.ts`**

```ts
// pi-agent-ext-subagent — public API barrel. Populated in Task 2.
export {};
```

- [ ] **Step 4: Install + build to verify the package scaffolding**

Run:
```bash
( cd bun-apps && bun install )
( cd bun-apps/pi-agent-ext-subagent && bun run build )
```
Expected: `bun install` links `@repo/pi-agent-ext-subagent` into `bun-apps/node_modules`; `bun run build` emits `dist/index.js` + `dist/index.d.ts`; exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/package.json bun-apps/pi-agent-ext-subagent/tsconfig.json bun-apps/pi-agent-ext-subagent/biome.json bun-apps/pi-agent-ext-subagent/.gitignore bun-apps/pi-agent-ext-subagent/src/index.ts bun-apps/bun.lock
git commit -m "feat(subagent): scaffold pi-agent-ext-subagent package"
```

---

## Task 2: Populate the new package (modules + singletons + tests)

**Files:**
- Create: 16 `src/*.ts` (copied from workflow), `src/config.ts` (split), `src/index.ts` (full barrel), `tests/*.test.ts` + helpers (copied)
- Test: `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )` green; workflow still untouched & green

**Interfaces:**
- Consumes: the existing workflow module sources (verbatim copy — intra-package `./xxx.js` imports among the 16 stay valid since they move together).
- Produces: `@repo/pi-agent-ext-subagent` exporting `spawnSubagent`, `WorkflowAgent`, `createSubagentTool`, `createSubagentRunsTool`, `getSubagentInFlightRegistry`, `getSubagentRunPersistence`, `createWorktree`/`removeWorktree`, errors/types/config/home — all symbols workflow currently re-exports.

- [ ] **Step 1: Copy the 16 engine/data modules**

```bash
cd bun-apps/pi-agent-ext-workflow/src
for m in spawn-subagent agent agent-history agent-registry errors model-tier-config sdd-report structured-output git-scope worktree home subagent-tool subagent-runs-tool subagent-run-persistence subagent-in-flight; do
  cp "$m.ts" ../../pi-agent-ext-subagent/src/"$m.ts"
done
```

(All `./xxx.js` imports among these 16 point at each other and remain valid in the new `src/`. External imports `@earendil-works/*`, `typebox`, `node:*` are unchanged.)

- [ ] **Step 2: Replace `config.ts` with the split version**

Overwrite `bun-apps/pi-agent-ext-subagent/src/config.ts` (only the symbols the moved modules actually import — `MODEL_TIERS_FILE` via model-tier-config, `AGENTS_DIR` via agent-registry; verified by grep):

```ts
/**
 * Configuration constants for pi-agent-ext-subagent (extracted from
 * pi-agent-ext-workflow/src/config.ts). Only symbols referenced by the moved
 * modules live here; workflow-side constants (WORKFLOW_*, MAX_AGENT_*,
 * normalizeKeywordTriggerWord, DEFAULT_*) remain in pi-agent-ext-workflow.
 */

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/**
 * Named workflow subagent definitions directory. Resolved both project-relative
 * (cwd/.pi/agents) and home-relative (~/.pi/agents); project entries win on name
 * collision. Each `*.md` file is an agent definition (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
```

- [ ] **Step 3: Verify the config split is complete (no moved module needs another config symbol)**

Run:
```bash
grep -rhn 'from "\./config\.js"' bun-apps/pi-agent-ext-subagent/src/
```
Expected: exactly two lines — `agent-registry.ts` importing `{ AGENTS_DIR }` and `model-tier-config.ts` importing `{ MODEL_TIERS_FILE }`. If anything else appears, add that symbol to the new `config.ts`.

- [ ] **Step 4: Add the singleton accessors (then their contract test in Step 6)**

Append to `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` (after the `SubagentInFlightRegistry` class):

```ts
let _registrySingleton: SubagentInFlightRegistry | undefined;
/**
 * Process-wide singleton so the `subagent` tool (subagent extension) and the
 * `/subagents` viewer/command (workflow extension) share ONE registry across
 * extensions. Importers MUST use the src subpath (`@repo/pi-agent-ext-subagent/src/...`)
 * so both extensions resolve the same module instance.
 */
export function getSubagentInFlightRegistry(): SubagentInFlightRegistry {
  return (_registrySingleton ??= new SubagentInFlightRegistry());
}
```

Append to `bun-apps/pi-agent-ext-subagent/src/subagent-run-persistence.ts` (after `createSubagentRunPersistence`):

```ts
let _persistenceSingleton: ReturnType<typeof createSubagentRunPersistence> | undefined;
/** Process-wide singleton (see getSubagentInFlightRegistry). */
export function getSubagentRunPersistence() {
  return (_persistenceSingleton ??= createSubagentRunPersistence());
}
```

- [ ] **Step 5: Write the full public barrel `src/index.ts`**

Overwrite `bun-apps/pi-agent-ext-subagent/src/index.ts`:

```ts
// agent
export type { AgentRunOptions, AgentRunResult, AgentUsage, WorkflowAgentOptions } from "./agent.js";
export { listAvailableModelSpecs, WorkflowAgent } from "./agent.js";
// agent-history
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory } from "./agent-history.js";
// agent-registry
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export { applyToolPolicy, listAgentTypes, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
// errors
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
// model-tier-config
export type { ModelTierConfig } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
// sdd-report
export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "./sdd-report.js";
// spawn-subagent
export type { SpawnSubagentOptions, SpawnSubagentPrime, SpawnSubagentResult } from "./spawn-subagent.js";
export { spawnSubagent } from "./spawn-subagent.js";
// structured-output
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
// subagent-run-persistence
export type {
  CreateSubagentRunPersistenceOptions,
  SubagentFsLayer,
  SubagentRunPersistence,
  SubagentRunRecord,
  SubagentRunStatus,
} from "./subagent-run-persistence.js";
export {
  createSubagentRunPersistence,
  generateSubagentRunId,
  getSubagentRunPersistence,
  SUBAGENT_HOME_RELATIVE_DIR,
  SUBAGENT_RUNS_SUBDIR,
  subagentHomeDir,
  subagentRunsDir,
} from "./subagent-run-persistence.js";
// subagent-in-flight
export type { InFlightSubagent } from "./subagent-in-flight.js";
export { SubagentInFlightRegistry, getSubagentInFlightRegistry } from "./subagent-in-flight.js";
// subagent-tool
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool.js";
export { createSubagentTool } from "./subagent-tool.js";
// subagent-runs-tool
export type { SubagentRunsToolOptions } from "./subagent-runs-tool.js";
export { createSubagentRunsTool } from "./subagent-runs-tool.js";
// worktree
export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
// config (split) + home
export { AGENTS_DIR, MODEL_TIERS_FILE } from "./config.js";
export { homeDir } from "./home.js";
```

- [ ] **Step 6: Add a singleton-contract test (the only new behavior)**

Create `bun-apps/pi-agent-ext-subagent/tests/singleton.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { getSubagentInFlightRegistry, SubagentInFlightRegistry } from "../src/subagent-in-flight.js";
import { createSubagentRunPersistence, getSubagentRunPersistence } from "../src/subagent-run-persistence.js";

describe("subagent singletons", () => {
  it("getSubagentInFlightRegistry returns one shared instance", () => {
    expect(getSubagentInFlightRegistry()).toBe(getSubagentInFlightRegistry());
    expect(getSubagentInFlightRegistry()).toBeInstanceOf(SubagentInFlightRegistry);
  });
  it("getSubagentRunPersistence returns one shared instance", () => {
    expect(getSubagentRunPersistence()).toBe(getSubagentRunPersistence());
  });
  it("factories still construct independent instances (test injection)", () => {
    expect(new SubagentInFlightRegistry()).not.toBe(getSubagentInFlightRegistry());
    expect(createSubagentRunPersistence()).not.toBe(getSubagentRunPersistence());
  });
});
```
> The cross-extension identity (same instance reaches the workflow-side `/subagents` viewer) is verified by the Task 6 manual smoke — it cannot be asserted within one package.

- [ ] **Step 7: Copy the moved tests + any helpers they need**

```bash
cd bun-apps/pi-agent-ext-workflow/tests
for t in agent agent-history agent-registry errors git-scope model-tier-config sdd-report spawn-subagent structured-output subagent-in-flight subagent-run-persistence subagent-runs-tool subagent-tool worktree regression-subagent-contract; do
  cp "$t.test.ts" ../../pi-agent-ext-subagent/tests/"$t.test.ts"
done
# Helpers used by moved tests:
grep -l 'from "\./helpers' ../../pi-agent-ext-subagent/tests/*.test.ts 2>/dev/null
```
For each helper path the grep prints, copy it: `cp -r helpers/<name> ../../pi-agent-ext-subagent/tests/helpers/<name>` (create `tests/helpers/` first). Re-run the grep until empty.

> Moved tests import via `../src/...` (relative) — valid in the new package unchanged. Do NOT copy `subagent-viewer.test.ts`, `subagents-command.test.ts`, `extension-subagent-registration.test.ts`, `regression-ext-workflow-protection.test.ts` — those stay in workflow (Task 4/6 adapts the two registration/protection tests).

- [ ] **Step 8: Check + build + test the new package**

Run:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run check )
( cd bun-apps/pi-agent-ext-subagent && bun run build )
( cd bun-apps/pi-agent-ext-subagent && bun test )
```
Expected: biome clean; tsc emits `dist/` with zero errors; all moved tests pass (same assertions as in workflow — behavior is identical). If a moved test references a symbol that didn't get exported, add it to `src/index.ts` or import directly from `../src/...` in that test (matching how it read before).

- [ ] **Step 9: Confirm workflow still green (untouched)**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )
```
Expected: green (workflow still has its originals).

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/
git commit -m "feat(subagent): move engine+tools+tests into pi-agent-ext-subagent"
```

---

## Task 3: Atomic cutover — workflow imports from the new package

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/package.json` (add dep)
- Modify: `bun-apps/pi-agent-ext-workflow/src/index.ts` (moved exports → re-exports)
- Modify: all staying workflow files that imported moved modules (rewrite import paths)
- Delete: the 16 moved `src/*.ts` + 15 moved `tests/*.test.ts` (and now-unused helpers) from workflow
- Test: both packages `bun run check && build && test` green

**Interfaces:**
- Consumes: `@repo/pi-agent-ext-subagent` public API (+ src subpath for singletons).
- Produces: workflow no longer owns subagent sources; its `index.ts` re-exports the same symbols (backward compat) so any untouched consumer keeps working.

- [ ] **Step 1: Add the workspace dependency**

In `bun-apps/pi-agent-ext-workflow/package.json`, change:
```json
  "dependencies": {
    "acorn": "^8.16.0"
  },
```
to:
```json
  "dependencies": {
    "@repo/pi-agent-ext-subagent": "workspace:*",
    "acorn": "^8.16.0"
  },
```
Run `( cd bun-apps && bun install )`.

- [ ] **Step 2: Rewrite workflow's `src/index.ts` — moved exports become re-exports**

For every export line in `bun-apps/pi-agent-ext-workflow/src/index.ts` whose `from "./<moved>.js"` target is one of the 16 moved modules, change the source to `from "@repo/pi-agent-ext-subagent"`. Concretely replace each of these blocks (keep the `export`/`export type` keywords and symbol lists byte-identical; only the `from` changes):

- `agent.js` → `@repo/pi-agent-ext-subagent` (AgentRunOptions/AgentRunResult/AgentUsage/WorkflowAgentOptions type export, and listAvailableModelSpecs/WorkflowAgent value export)
- `agent-history.js`, `agent-registry.js`, `errors.js`, `model-tier-config.js`, `sdd-report.js`, `structured-output.js`, `spawn-subagent.js`, `subagent-run-persistence.js`, `subagent-runs-tool.js`, `subagent-tool.js`, `worktree.js` → `@repo/pi-agent-ext-subagent`
- `export * from "./config.js"`: split — keep `export * from "./config.js"` (workflow's config keeps WORKFLOW_*/MAX_AGENT_*/normalizeKeywordTriggerWord) AND add `export { AGENTS_DIR, MODEL_TIERS_FILE } from "@repo/pi-agent-ext-subagent";` so the moved config symbols remain reachable via workflow's barrel for backward compat.
- `home.js` → change `export { homeDir } from "./home.js"` to `export { homeDir } from "@repo/pi-agent-ext-subagent";`

Leave all workflow-side exports (`workflow.js`, `workflow-*.js`, `display.js`, `task-panel.js`, `effort-command.js`, `adversarial-review.js`, `deep-research.js`, `run-persistence.js`, `web-tools.js`, etc.) unchanged.

- [ ] **Step 3: Rewrite staying files' direct `./<moved>.js` imports**

For each staying file below, change the listed `from "./<moved>.js"` to `from "@repo/pi-agent-ext-subagent"` (symbols unchanged):

| File | Rewrites (`./x.js` → new pkg) |
|---|---|
| `src/workflow.ts` | `agent`, `agent-history`, `agent-registry`, `errors`, `sdd-report`, `worktree` |
| `src/workflow-pack.ts` | `agent` |
| `src/workflow-manager.ts` | `agent`, `errors` |
| `src/workflow-tool.ts` | `agent`, `agent-registry`, `errors` |
| `src/workflows-models-command.ts` | `agent`, `model-tier-config` |
| `src/run-persistence.ts` | `agent-history`, `errors` |
| `src/host-fn-helpers.ts` | `errors` |
| `src/display.ts` | `agent-history`, `errors` |
| `src/call-global.ts` | `errors` |
| `src/task-panel.ts` | `agent-history` |
| `src/workflow-ui.ts` | `agent-history` |
| `src/workflow-paths.ts` | `home` (config stays local) |
| `src/subagent-viewer.ts` | `agent`, `agent-history`, `subagent-in-flight`, `subagent-tool` (display stays local) |
| `src/subagents-command.ts` | `subagent-in-flight` (subagent-viewer stays local) |
| `extensions/workflow.ts` | `subagent-in-flight` (`SubagentInFlightRegistry`), `subagent-run-persistence` (`createSubagentRunPersistence`), `subagent-tool` (`createSubagentTool`), `subagent-runs-tool` (`createSubagentRunsTool`) — **symbol-preserving**: workflow.ts still creates + registers the tools here (now from the new package); Task 4 strips the creation and switches to singletons. Import these four from the root `@repo/pi-agent-ext-subagent` (NOT src subpath yet — workflow still makes its own instance until Task 4). |

Mechanism (per file, per module): edit the `from "./<module>.js"` → `from "@repo/pi-agent-ext-subagent"` (for `extensions/workflow.ts` the four subagent modules are `from "../src/<module>.js"` → `from "@repo/pi-agent-ext-subagent"`). Verify nothing was missed:
```bash
grep -rn 'from "\./\(spawn-subagent\|agent\|agent-history\|agent-registry\|errors\|model-tier-config\|sdd-report\|structured-output\|git-scope\|worktree\|home\|subagent-tool\|subagent-runs-tool\|subagent-run-persistence\|subagent-in-flight\)\.js"' bun-apps/pi-agent-ext-workflow/src/ bun-apps/pi-agent-ext-workflow/extensions/
```
Expected after rewrites: **zero matches** (all moved-module imports now point at `@repo/pi-agent-ext-subagent`). The only remaining `./config.js` / `./home.js` references must be `./config.js` (staying) — confirm `./home.js` is gone (home fully moved).

- [ ] **Step 4: Delete the moved sources + tests from workflow**

```bash
cd bun-apps/pi-agent-ext-workflow
git rm src/spawn-subagent.ts src/agent.ts src/agent-history.ts src/agent-registry.ts src/errors.ts src/model-tier-config.ts src/sdd-report.ts src/structured-output.ts src/git-scope.ts src/worktree.ts src/home.ts src/subagent-tool.ts src/subagent-runs-tool.ts src/subagent-run-persistence.ts src/subagent-in-flight.ts
git rm tests/agent.test.ts tests/agent-history.test.ts tests/agent-registry.test.ts tests/errors.test.ts tests/git-scope.test.ts tests/model-tier-config.test.ts tests/sdd-report.test.ts tests/spawn-subagent.test.ts tests/structured-output.test.ts tests/subagent-in-flight.test.ts tests/subagent-run-persistence.test.ts tests/subagent-runs-tool.test.ts tests/subagent-tool.test.ts tests/worktree.test.ts tests/regression-subagent-contract.test.ts
```
If a copied helper in `tests/helpers/` is now used only by deleted tests, `git rm` it too. Leave workflow's `src/config.ts` (it still holds the WORKFLOW_*/MAX_AGENT_* constants).

- [ ] **Step 5: Build + test workflow**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun test )
```
Expected: green. Common failures + fixes:
- "Cannot find module ./xxx.js" → a staying file still imports a moved module; rerun the Step 3 grep.
- TS error on a re-export → the symbol name/spelling drifts between workflow's old export and the new package's export; align them.

- [ ] **Step 6: Build + test the new package still green**

Run:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run build && bun test )
```
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow bun-apps/bun.lock
git commit -m "refactor(workflow): import subagent subsystem from pi-agent-ext-subagent"
```

---

## Task 4: New `extensions/subagent.ts` + register statically; strip workflow's tool registration

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts`
- Modify: `bun-apps/pi-agent/src/static-extensions.ts` (register subagent before workflow)
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` (drop subagent tool creation/registration; read singletons from new pkg)
- Modify/Move: `bun-apps/pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts` (now tests the new extension) and `tests/regression-ext-workflow-protection.test.ts` (guard semantics changed)
- Test: both packages green; `subagent` + `subagent_runs` register exactly once; `/subagents` shows live runs

**Interfaces:**
- Consumes: `createSubagentTool`, `createSubagentRunsTool`, `getSubagentInFlightRegistry`, `getSubagentRunPersistence` from `../src/index.js`.
- Produces: a pi extension factory registered statically that owns the two tools + the shared singletons.

- [ ] **Step 1: Create `extensions/subagent.ts`**

```ts
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createSubagentRunsTool,
  createSubagentTool,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
} from "../src/index.js";

/**
 * pi-agent-ext-subagent — owns the `subagent` + `subagent_runs` tools and the
 * shared in-flight registry / run-persistence singletons. Extracted from
 * pi-agent-ext-workflow so the subagent capability loads independently of the
 * workflow DSL. The `/subagents` viewer + command stay in workflow and read the
 * same singletons (imported via the src subpath for module identity).
 *
 * session_start captures parent-session tools + the main model from the SAME
 * sources workflow used (pi.getAllToolDefinitions / ctx.model), independently
 * of workflow's closure.
 */
export default function extension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  const mainModelHolder: { current: string | undefined } = { current: undefined };

  const inFlight = getSubagentInFlightRegistry();
  const persistence = getSubagentRunPersistence();

  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => mainModelHolder.current,
    inFlight,
    persistence,
  });

  // Best-effort guard: warn if another extension already registered 'subagent'.
  try {
    const activeAtLoad = pi.getActiveTools();
    if (Array.isArray(activeAtLoad) && activeAtLoad.includes("subagent")) {
      console.warn(
        "[pi-agent-ext-subagent] a 'subagent' tool is already active; the two will shadow each other. This repo expects pi-agent-ext-subagent to own the 'subagent' name.",
      );
    }
  } catch {
    // getActiveTools may be unavailable in some hosts — best-effort only.
  }
  pi.registerTool(subagentTool);

  const subagentRunsTool = createSubagentRunsTool({ persistence });
  pi.registerTool(subagentRunsTool);

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      extensionToolsHolder.current = extTools;
    }
    mainModelHolder.current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  });
}
```

- [ ] **Step 2: Register statically (before workflow)**

In `bun-apps/pi-agent/src/static-extensions.ts`, add the import (Group B area, relative path — required for `bun build --compile`):
```ts
import subagentExtension from "../../pi-agent-ext-subagent/extensions/subagent.ts";
```
In `STATIC_EXTENSION_FACTORIES`, insert immediately BEFORE the workflow entry:
```ts
	// subagent — owns subagent + subagent_runs tools + shared singletons; must
	// load before workflow so workflow's /subagents viewer reads a populated registry.
	{ name: "pi-agent-ext-subagent", factory: subagentExtension },
	{ name: "pi-agent-ext-workflow", factory: workflowExtension },
```

- [ ] **Step 3: Strip subagent tool registration from `workflow.ts`**

In `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` (Task 3 rewired the four subagent-module imports to the root `@repo/pi-agent-ext-subagent`; now finalize):
- Remove imports: `createSubagentTool` and `createSubagentRunsTool` entirely (no longer created here — the subagent extension owns them).
- Replace the `SubagentInFlightRegistry` + `createSubagentRunPersistence` imports with the singleton import via **src subpath** (module identity — the subagent extension loads via `../src/`, so workflow must match):
  ```ts
  import { getSubagentInFlightRegistry, getSubagentRunPersistence } from "@repo/pi-agent-ext-subagent/src/index.js";
  ```
- Replace `const subagentInFlight = new SubagentInFlightRegistry();` → `const subagentInFlight = getSubagentInFlightRegistry();`
- Replace `const subagentPersistence = createSubagentRunPersistence();` → `const subagentPersistence = getSubagentRunPersistence();`
- Delete the `createSubagentTool({ ... })` block, the `'subagent'` load-order `try/catch` warn, `pi.registerTool(subagentTool)`, and `pi.registerTool(subagentRunsTool)` + its `createSubagentRunsTool({ persistence })`.
- Keep `pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight }));` (command stays in workflow; reads the shared singleton).
- Keep workflow's own `extensionToolsHolder` + `manager.setExtensionTools(extTools)` + `manager.setMainModel(...)` in session_start (workflow runs still need them). Drop only the now-unused `extensionToolsHolder.current = extTools` assignment IF biome flags it as unused; otherwise leave it.

- [ ] **Step 4: Adapt the two registration/protection tests**

- `tests/extension-subagent-registration.test.ts`: it currently asserts the WORKFLOW extension registers `subagent`. Move it to `bun-apps/pi-agent-ext-subagent/tests/extension-subagent-registration.test.ts` and repoint the import to the new factory `import extension from "../extensions/subagent.ts"` (or the mocked pi harness it already uses), asserting `subagent` + `subagent_runs` are registered by the subagent extension. Inspect first:
  ```bash
  cat bun-apps/pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts
  ```
  Keep its mock-pi harness; change only the factory under test + expected tool set.
- `tests/regression-ext-workflow-protection.test.ts`: read it; the "workflow owns subagent" guard text moved. Update the assertion to the new `[pi-agent-ext-subagent]` warn text (or to assert workflow no longer registers `subagent`). If it's solely about workflow's ownership guard, retire or rewrite it to assert the subagent extension's own guard.

- [ ] **Step 5: Build + test both packages**

Run:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )
( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun test )
```
Expected: green. Then verify pi-agent still type-checks with the new static import:
```bash
( cd bun-apps/pi-agent && bun run build )
```
Expected: green (the static import drags the new extension into the type graph — any type error in the new package surfaces here).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/extensions/subagent.ts bun-apps/pi-agent/src/static-extensions.ts bun-apps/pi-agent-ext-workflow/extensions/workflow.ts bun-apps/pi-agent-ext-workflow/tests bun-apps/pi-agent-ext-subagent/tests
git commit -m "feat(subagent): register subagent extension; workflow reads shared singletons"
```

---

## Task 5: Migrate `knowledge-card` onto the new package

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (import path)
- Modify: `bun-apps/pi-agent-ext-knowledge-card/package.json` (swap dep)
- Test: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )` green

**Interfaces:** knowledge-card consumes only `spawnSubagent` + `SpawnSubagentOptions`/`SpawnSubagentResult` from `@repo/pi-agent-ext-subagent` (root/dist entry — it shares no singleton, so dist is fine).

- [ ] **Step 1: Swap the import**

In `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts`, change:
```ts
import {
	spawnSubagent as __defaultSpawnSubagent,
	type SpawnSubagentOptions,
	type SpawnSubagentResult,
} from "@repo/pi-agent-ext-workflow";
```
to:
```ts
import {
	spawnSubagent as __defaultSpawnSubagent,
	type SpawnSubagentOptions,
	type SpawnSubagentResult,
} from "@repo/pi-agent-ext-subagent";
```

- [ ] **Step 2: Swap the dependency**

In `bun-apps/pi-agent-ext-knowledge-card/package.json`: remove `"@repo/pi-agent-ext-workflow"` (from `dependencies` or `devDependencies`, wherever it is) and add `"@repo/pi-agent-ext-subagent": "workspace:*"`. Run:
```bash
( cd bun-apps && bun install )
```

- [ ] **Step 3: Verify no other workflow import remains in knowledge-card**

Run:
```bash
grep -rn "@repo/pi-agent-ext-workflow" bun-apps/pi-agent-ext-knowledge-card/
```
Expected: zero matches.

- [ ] **Step 4: Build + test**

Run:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run build )   # ensure dist exists for the root import
( cd bun-apps/pi-agent-ext-knowledge-card && bun run check && bun test )
```
Expected: green (the `zk_*` spawn path still works through the lighter package).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card bun-apps/bun.lock
git commit -m "refactor(knowledge-card): depend on pi-agent-ext-subagent for spawnSubagent"
```

---

## Task 6: Full verification + docs + boot-smoke wiring

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/__tests__/boot-smoke.test.ts` (add `buildIfMissing` for the new pkg)
- Create: `bun-apps/pi-agent-ext-subagent/README.md`, `CONTEXT.md`, `docs/adr/0001-why-extracted.md`
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md` (point `spawnSubagent` entry at the new pkg)
- Test: full repo test pass + schema-cost sanity

- [ ] **Step 1: Wire boot-smoke build for the new package**

In `bun-apps/pi-agent-cli/src/__tests__/boot-smoke.test.ts`, next to the existing `buildIfMissing("pi-agent-ext-workflow", "build", "dist/index.js")`, add:
```ts
buildIfMissing("pi-agent-ext-subagent", "build", "dist/index.js");
```
So any CLI test that loads extensions builds the new package's dist first.

- [ ] **Step 2: Run the full verification suite**

Run each; all must pass:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun run test )
( cd bun-apps/pi-agent-ext-workflow && bun run test )
( cd bun-apps/pi-agent-ext-knowledge-card && bun test )
( cd bun-apps/pi-agent && bun run build )
bun run --cwd bun-apps/pi-agent-cli check:schema
```
Expected: all green; `check:schema` shows `subagent`/`subagent_runs` present once each and `workflow`/`workflow_control` present (no duplicates, no missing).

- [ ] **Step 3: Manual smoke — shared singleton across extensions**

Start pi in the repo, then in a session:
1. Confirm `subagent`, `subagent_runs`, `workflow`, `workflow_control` tools are all active.
2. Trigger a long-ish subagent, e.g. `subagent({ task: "read README.md and summarize", tools: ["read"] })`.
3. While it runs, open `/subagents` — it MUST show the in-flight run. (This proves the subagent extension's registry and workflow's viewer share ONE singleton instance via the src-subpath import.)
4. After completion, `/subagents` lists the completed run with output (proves run-persistence singleton is shared too).

If `/subagents` shows nothing during the run: the singleton identity broke — confirm workflow imports via `@repo/pi-agent-ext-subagent/src/index.js` (NOT the dist root) and the extension imports via `../src/index.js`.

- [ ] **Step 4: Write docs**

- `bun-apps/pi-agent-ext-subagent/README.md` — one-paragraph purpose + public API (`spawnSubagent`, `WorkflowAgent`, tools, singletons) + the module-identity rule for peer extensions.
- `bun-apps/pi-agent-ext-subagent/CONTEXT.md` — ubiquitous language: subagent / spawn / in-flight registry / run-persistence / agent-registry / model-tier.
- `bun-apps/pi-agent-ext-subagent/docs/adr/0001-why-extracted.md` — why extracted, why viewer/command stayed (display→workflow cycle), why Design B (own extension), the singleton module-identity decision.
- Edit `bun-apps/pi-agent-ext-workflow/CONTEXT.md` `spawnSubagent` entry → "moved to pi-agent-ext-subagent; re-exported here for backward compat."
- If a root `CONTEXT-MAP.md` exists, add the new context (per `docs/agents/domain.md`).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/README.md bun-apps/pi-agent-ext-subagent/CONTEXT.md bun-apps/pi-agent-ext-subagent/docs bun-apps/pi-agent-ext-workflow/CONTEXT.md bun-apps/pi-agent-cli/src/__tests__/boot-smoke.test.ts
git commit -m "docs(subagent): README/CONTEXT/ADR + boot-smoke wiring; full verification"
```

---

## Self-Review (against spec)

**Spec coverage:**
- Module manifest (16 moves / stays / config+home split) → Task 2 (copy) + Task 3 (delete). ✓
- Design B extension wiring (`extensions/subagent.ts`, session_start capture, singletons, static-extensions before workflow) → Task 4. ✓
- Cross-package rewrites (A symbol-preserving / B workflow.ts structural / C zero-change / D index re-export) → Task 3 Steps 2–3. ✓
- knowledge-card migration → Task 5. ✓
- Backward compat (workflow re-export) → Task 3 Step 2. ✓
- Dependencies (new pkg package.json; workflow adds dep) → Task 1 Step 1 + Task 3 Step 1. ✓
- Risk #1 (singleton module identity via src subpath) → Task 4 Step 3 + Task 6 Step 3. ✓
- Risk #2 (build consistency / boot-smoke) → Task 6 Step 1. ✓
- Verification (8 spec items) → Task 6 Step 2 + Step 3 manual. ✓
- Docs (CONTEXT/ADR/README, CONTEXT-MAP) → Task 6 Step 4. ✓

**Placeholder scan:** no TBD/TODO; every code step shows actual code; every test step shows the command + expected result. The two `INSPECT` items (registration/protection tests in Task 4 Step 4) give the exact read-then-adapt instruction + the new assertion target — not a placeholder.

**Type consistency:** `getSubagentInFlightRegistry()` / `getSubagentRunPersistence()` spelled identically in Task 2 Step 4 (definition), Task 4 Step 1 (extension), Task 4 Step 3 (workflow import). `createSubagentTool` option names (`getExtensionTools`/`getMainModel`/`inFlight`/`persistence`) match the interface verified in the codebase.
