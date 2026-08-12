# core-runtime Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `@repo/pi-agent-ext-core-runtime` (shared agent-execution runtime) out of `pi-agent-ext-subagent`, so `pi-agent-ext-workflow` and `pi-agent-ext-subagent` both depend downward on it — eliminating the lateral `workflow → subagent` npm edge while preserving all co-working behavior.

**Architecture:** Lift a self-contained 15-file runtime closure (agent dispatch, registry, rate-limiter, history, errors, SDD, model-tier config, in-flight registry, worktrees, structured output, display helpers, home/config) from `subagent/src` into a new sibling library `core-runtime`. Both packages import from it. `WorkflowAgent` is renamed `CoreAgent` with a `WorkflowAgent = CoreAgent` back-compat alias. Deep-path imports across the repo are flattened first; workflow's dead back-compat re-export block is deleted.

**Tech Stack:** Bun workspace, TypeScript consumed as source (`main: ./src/index.ts`), `@earendil-works/pi-coding-agent` SDK, `typebox`, Biome.

**Spec:** `.planning/core-runtime-extraction/spec.md`

## Global Constraints

- **Workspace root:** `bun-apps/`. Run `bun install` from `bun-apps/`, never the repo root.
- **Shell discipline:** never top-level `cd`; use `( cd <dir> && ... )` subshells.
- **Written artifacts in English** (code, comments, commits).
- **No new pi extension:** `core-runtime` is a library — no `extensions/`, no `pi.skills`, not registered in `pi-agent/run-dir/manifest.json` or `pi-agent/src/static-extensions.ts`.
- **Consumed-as-source:** new package `main`/`types`/`exports["."]` point at `./src/index.ts` (no build step), matching subagent + core-interface.
- **Back-compat preserved:** `WorkflowAgent` keeps resolving (alias) from both subagent and workflow; subagent's public barrel surface is preserved via re-exports.
- **Each task ends green:** typecheck + tests pass before commit.
- **Typecheck command (uniform):** `( cd bun-apps/<pkg> && bunx tsc --noEmit )`.
- **Dependency direction stays acyclic:** new edges `subagent → core-runtime` and `workflow → core-runtime` are declared in each package's `dependencies` (`workspace:*`). Repo guard `bun-apps/tests/dep-guard.test.ts` must stay green.

---

### Task 1: Flatten `@repo/pi-agent-ext-subagent/src/*` deep-path imports to package root

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts:8`
- Modify: `bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts:1-3`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/{background-review,session-flush,auto-consolidate,correction-detector}.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/auto-consolidate.test.ts:3`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/tests/handlers/{background-review,session-flush,correction-detector,auto-consolidate}.test.ts`
- Modify: `bun-apps/pi-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts:4`

**Interfaces:**
- Consumes: nothing (pure mechanical normalization).
- Produces: zero `@repo/pi-agent-ext-subagent/src/` deep-paths remain (all resolve via the package barrel). The 3 `@repo/pi-agent-ext-subagent/extensions/subagent.ts` deep-paths in `tool-gate` are intentionally LEFT (extension-to-extension wiring, not lib symbols).

**Transform:** change every module specifier `@repo/pi-agent-ext-subagent/src/<...>.ts` → `@repo/pi-agent-ext-subagent` (drop the `/src/...` suffix). Imported symbol names unchanged. The `typeof import("@repo/pi-agent-ext-subagent/src/index.ts")` casts in hermes-memory tests become `typeof import("@repo/pi-agent-ext-subagent")`.

- [ ] **Step 1: flatten workflow + obsidian**
  - `workflow/extensions/workflow.ts:8`: `from "@repo/pi-agent-ext-subagent/src/subagent-in-flight.ts"` → `from "@repo/pi-agent-ext-subagent"`.
  - `obsidian/src/lib/subagent.ts:1-3`: drop the `/src/subagent-in-flight.ts`, `/src/subagent-run-persistence.ts`, `/src/spawn-subagent-subprocess.ts` suffixes.

- [ ] **Step 2: flatten hermes-memory source + colocated test**
  - 5 source lines (background-review.ts:15, session-flush.ts:8, auto-consolidate.ts:16, correction-detector.ts:12) + auto-consolidate.ts:17 type import: `.../src/index.ts` → root.
  - `auto-consolidate.test.ts:3`: type import → root.

- [ ] **Step 3: flatten hermes-memory tests/handlers (4 files)**
  - 4 `import type { SpawnSubagentOptions, SpawnSubagentResult } from ".../src/index.ts"` (background-review.test.ts:4, session-flush.test.ts:13, correction-detector.test.ts:16, auto-consolidate.test.ts:16) → root.
  - 4 `typeof import("@repo/pi-agent-ext-subagent/src/index.ts").spawnSubagent` casts (background-review.test.ts:46, session-flush.test.ts:47, correction-detector.test.ts:269, auto-consolidate.test.ts:60) → `typeof import("@repo/pi-agent-ext-subagent").spawnSubagent`.

- [ ] **Step 4: flatten file2md**
  - `__tests__/resolve-vision-llm.test.ts:4`: `from "@repo/pi-agent-ext-subagent/src/model-role-config.ts"` → root.

- [ ] **Step 5: verify no deep-paths remain**
  Run: `grep -rn '@repo/pi-agent-ext-subagent/src/' --include='*.ts' . | grep -v node_modules | grep -v '/dist/'`
  Expected: zero matches.

- [ ] **Step 6: typecheck affected packages**
  Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit )` ; `( cd bun-apps/pi-agent-ext-obsidian && bunx tsc --noEmit )` ; `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` ; `( cd bun-apps/pi-agent-ext-file2md && bunx tsc --noEmit )`
  Expected: all pass.

- [ ] **Step 7: commit**
  `git add -A && git commit -m "refactor: flatten subagent src/* deep-path imports to package root"`

---

### Task 2: Scaffold `@repo/pi-agent-ext-core-runtime`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/package.json`
- Create: `bun-apps/pi-agent-ext-core-runtime/tsconfig.json`
- Create: `bun-apps/pi-agent-ext-core-runtime/src/index.ts` (empty barrel)
- Create: `bun-apps/pi-agent-ext-core-runtime/.gitignore`

**Interfaces:**
- Consumes: nothing yet.
- Produces: an empty, installable workspace package `@repo/pi-agent-ext-core-runtime` that typechecks.

- [ ] **Step 1: create package.json**
```json
{
  "name": "@repo/pi-agent-ext-core-runtime",
  "version": "0.1.0",
  "private": true,
  "description": "Shared agent-execution runtime for pi-agent-ext-subagent and pi-agent-ext-workflow (agent dispatch, registry, rate-limiter, history, errors, model-tier config, display).",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "files": ["src/", "README.md"],
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "check": "biome check ."
  },
  "keywords": ["pi-package", "agent-runtime", "core"],
  "license": "MIT",
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "0.84.1",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "0.84.1",
    "@earendil-works/pi-coding-agent": "0.84.1",
    "@repo/pi-agent-ext-core-interface": "workspace:*",
    "@types/bun": "^1.3.14",
    "typebox": "^1.3.7",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: create tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "types": ["bun", "@repo/pi-agent-ext-core-interface"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
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

- [ ] **Step 3: create src/index.ts**
```ts
// Shared agent-execution runtime. Populated in Task 3.
export {};
```

- [ ] **Step 4: create .gitignore** with one line: `dist/`

- [ ] **Step 5: install + typecheck**
  Run: `( cd bun-apps && bun install )` then `( cd bun-apps/pi-agent-ext-core-runtime && bunx tsc --noEmit )`
  Expected: install succeeds; typecheck passes (empty module).

- [ ] **Step 6: commit**
  `git add -A && git commit -m "feat(core-runtime): scaffold @repo/pi-agent-ext-core-runtime package"`

---

### Task 3: Move the 15-file runtime closure into core-runtime; rename WorkflowAgent → CoreAgent

**Files:**
- Copy (subagent/src → core-runtime/src): `agent.ts`, `agent-history.ts`, `agent-registry.ts`, `agent-row-display.ts`, `config.ts`, `errors.ts`, `home.ts`, `model-role-config.ts`, `model-tier-config.ts`, `rate-limiter.ts`, `sdd-report.ts`, `structured-output.ts`, `subagent-in-flight.ts`, `tool-action-label.ts`, `worktree.ts`
- Modify: `core-runtime/src/agent.ts` (rename class `WorkflowAgent` → `CoreAgent`)
- Create: `core-runtime/src/index.ts` (full barrel — Step 3)

**Interfaces:**
- Consumes: the empty core-runtime package (Task 2).
- Produces: `@repo/pi-agent-ext-core-runtime` exporting `CoreAgent` (+ `WorkflowAgent` alias) and all runtime symbols.

> ⚠️ **Use COPY, not `git mv`.** subagent must stay green until Task 4 rewires it. The subagent originals are deleted in Task 4. Between Task 3 and Task 4, core-runtime holds its own copies; subagent's originals are untouched.

- [ ] **Step 1: copy the 15 files**
  Run (repo root):
```bash
for f in agent agent-history agent-registry agent-row-display config errors home model-role-config model-tier-config rate-limiter sdd-report structured-output subagent-in-flight tool-action-label worktree; do
  cp "bun-apps/pi-agent-ext-subagent/src/$f.ts" "bun-apps/pi-agent-ext-core-runtime/src/$f.ts"
done
```
  Intra-closure relative imports (`./errors.js` etc.) resolve unchanged inside core-runtime.

- [ ] **Step 2: rename the class in core-runtime/src/agent.ts**
  Change `export class WorkflowAgent` → `export class CoreAgent`; update any other in-file references to the class name within agent.ts to `CoreAgent`. Keep the `WorkflowAgentOptions` type name as-is. Verify no OTHER moved file imports the class:
  `( cd bun-apps/pi-agent-ext-core-runtime && grep -rn 'WorkflowAgent' src )` — expect matches only inside agent.ts. If another moved file imports `WorkflowAgent`, change it to `CoreAgent`.

- [ ] **Step 3: write the barrel core-runtime/src/index.ts**
```ts
// Shared agent-execution runtime for pi-agent-ext-subagent and pi-agent-ext-workflow.
// Public surface mirrors the former subagent barrel (behavior-preserving sourcing)
// plus internal-consumer symbols. WorkflowAgent is the back-compat alias for CoreAgent.

export type {
  AgentRunOptions, AgentRunResult, AgentUsage, BudgetExhaustion,
  FallbackDecision, StructuredSession, WorkflowAgentOptions,
} from "./agent.js";
export {
  CoreAgent, checkBudgetExhaustion, extractValidated, lastAssistantError,
  listAvailableModelSpecs, resolveAgentModelSpec, resolveFallbackModel,
  resolveStructuredOutput, throwIfProviderLimit,
} from "./agent.js";
export { CoreAgent as WorkflowAgent } from "./agent.js";

export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryOptions, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory, summarizeLatestAction } from "./agent-history.js";

export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export { agentDefinitionKey, applyToolPolicy, listAgentTypes, loadAgentRegistry, parseAgentDefinition, resolveAgentType } from "./agent-registry.js";

export type { ActivityRow, ActivityStatus, ThemeLike } from "./agent-row-display.js";
export { NO_THEME, activityGlyph, fmtCost, fmtTokensShort, preview, renderActivityRow, shorten, shortModel } from "./agent-row-display.js";

export { AGENTS_DIR, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_TASKS, MAX_CONCURRENCY, MODEL_TIERS_FILE } from "./config.js";

export { WorkflowError, WorkflowErrorCode, classifyProviderLimit, isAbortError, isProviderUsageLimit, isTimeoutError, isWorkflowError, wrapError } from "./errors.js";

export { homeDir } from "./home.js";

export type { ModelTierConfig } from "./model-tier-config.js";
export { buildDefaultTierConfig, getModelTierConfigPath, loadModelTierConfig, resolveTierModel, saveModelTierConfig, sortedTierNames } from "./model-tier-config.js";
export { resolveModelRole } from "./model-role-config.js";

export type { RateLimitCapResolver, RateLimiter } from "./rate-limiter.js";
export { __resetRateLimitStateForTests, getGlobalRateLimiter, getRateLimitCapResolver, providerFromModelSpec, setRateLimitCapResolver } from "./rate-limiter.js";

export type { SddReport, SddReportStatus } from "./sdd-report.js";
export { SDD_REPORT_STATUSES, isSddReportActionable, parseSddReport } from "./sdd-report.js";

export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";

export type { InFlightSubagent } from "./subagent-in-flight.js";
export { SubagentInFlightRegistry, getSubagentInFlightRegistry } from "./subagent-in-flight.js";

export type { ToolActionContext } from "./tool-action-label.js";
export { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";

export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
```
> Sourcing: `ModelTierConfig` + 6 tier fns from `model-tier-config`, `resolveModelRole` from `model-role-config` — mirrors subagent's current barrel and avoids the 7 name collisions between the two model-config files.

- [ ] **Step 4: typecheck core-runtime**
  Run: `( cd bun-apps/pi-agent-ext-core-runtime && bunx tsc --noEmit )`
  Expected: PASS. If it reports a missing/ambiguous export, cross-check the symbol against its source file and fix that barrel line.

- [ ] **Step 5: commit**
  `git add -A && git commit -m "feat(core-runtime): move 15-file runtime closure; rename WorkflowAgent→CoreAgent"`

---

### Task 4: Rewire subagent to depend on core-runtime; back-compat re-exports; delete moved source

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/package.json` (add core-runtime dep)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts` (barrel → re-export moved symbols from core-runtime)
- Modify (rewire relative→package): `src/spawn-subagent.ts`, `src/spawn-subagent-subprocess.ts`, `src/subagents-tool.ts`, `src/subagent-tool.ts`, `src/subagent-tool-render.ts`, `src/subagent-tool-run.ts`, `src/subagent-tool-schema.ts`, `src/subagent-run-persistence.ts`, `src/subagent-viewer.ts`, `src/presets.ts`, `src/watchdog/model-review.ts`, `extensions/models-preset.ts`
- Delete: the 15 moved source files from `bun-apps/pi-agent-ext-subagent/src/`
- Move: any co-located test in subagent/src that tests a moved module (e.g. `src/tool-action-label.test.ts`) → `core-runtime/tests/` (rewire import)
- Modify: `bun-apps/pi-agent-ext-core-interface/src/seam-keys.ts` + `seam.ts` (repoint stale comments: rate-limit owner is now core-runtime)

**Interfaces:**
- Consumes: core-runtime's full public surface (Task 3).
- Produces: `pi-agent-ext-subagent` depends on `core-runtime` (downward); public barrel unchanged (back-compat re-exports); `tests/rate-limiter-cross-pkg.test.ts` still resolves (subagent barrel re-exports rate-limiter symbols from core-runtime).

- [ ] **Step 1: declare the dependency**
  In `bun-apps/pi-agent-ext-subagent/package.json` set `"dependencies": { "@repo/pi-agent-ext-core-runtime": "workspace:*" }`. Run `( cd bun-apps && bun install )`.

- [ ] **Step 2: rewrite subagent barrel src/index.ts**
  For every re-export sourcing a MOVED module (`./agent.js`, `./agent-history.js`, `./agent-registry.js`, `./agent-row-display.js`, `./config.js`, `./errors.js`, `./home.js`, `./model-role-config.js`, `./model-tier-config.js`, `./rate-limiter.js`, `./sdd-report.js`, `./structured-output.js`, `./subagent-in-flight.js`, `./tool-action-label.js`, `./worktree.js`), change the source to `@repo/pi-agent-ext-core-runtime`; keep the same exported symbol names (back-compat). Re-exports sourcing STAYED modules (`./spawn-subagent.js`, `./spawn-subagent-subprocess.js`, `./subagent-tool*.js`, `./subagents-tool.js`, `./subagent-runs-tool.js`, `./subagent-run-persistence.js`, `./subagent-viewer.js`, etc.) stay local. Add `export { CoreAgent } from "@repo/pi-agent-ext-core-runtime";` so the canonical name is available (WorkflowAgent already re-exports via the moved `./agent.js`→core-runtime line).

- [ ] **Step 3: rewire the 12 remaining importer files**
  Transform: `import ... from "./<moved-module>.js"` → `from "@repo/pi-agent-ext-core-runtime"` (drop the relative path; keep symbol names). Files: the 12 listed above. Files importing moved symbols via `./index.js` (`subagent-viewer.ts`, `subagent-context-widget.ts`, `subagents-command.ts`) need NO change (resolve via the rewritten barrel). Example: `src/spawn-subagent.ts:21` `import { type AgentUsage, type BudgetExhaustion, WorkflowAgent } from "./agent.js";` → `from "@repo/pi-agent-ext-core-runtime";`. Note the two-dot variants: `src/watchdog/model-review.ts:2` imports from `../model-role-config.js` and `extensions/models-preset.ts:20-21` from `../src/model-role-config.js` — both also become `from "@repo/pi-agent-ext-core-runtime"`.

- [ ] **Step 4: delete moved source + relocate co-located tests**
  Delete the 15 moved source files:
```bash
for f in agent agent-history agent-registry agent-row-display config errors home model-role-config model-tier-config rate-limiter sdd-report structured-output subagent-in-flight tool-action-label worktree; do
  rm "bun-apps/pi-agent-ext-subagent/src/$f.ts"
done
```
  For any `src/*.test.ts` that imports a moved module (e.g. `tool-action-label.test.ts`): `git mv` it to `bun-apps/pi-agent-ext-core-runtime/tests/` and rewire its import to `@repo/pi-agent-ext-core-runtime`.

- [ ] **Step 5: repoint stale comments in core-interface**
  In `bun-apps/pi-agent-ext-core-interface/src/seam-keys.ts` (~lines 13-15) and `src/seam.ts` (~lines 6-8), update prose saying the `__piRateLimitState` owner is `pi-agent-ext-subagent`/`rate-limiter.ts` → `pi-agent-ext-core-runtime`. Comments only.

- [ ] **Step 6: typecheck + test subagent**
  Run: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun test )`
  Expected: PASS. `tests/rate-limiter-cross-pkg.test.ts` passes (imports via subagent root, which re-exports from core-runtime).

- [ ] **Step 7: commit**
  `git add -A && git commit -m "refactor(subagent): depend on core-runtime; re-export moved runtime; delete moved source"`

---

### Task 5: Rewire workflow to depend on core-runtime; drop subagent peerDep

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/package.json` (add core-runtime dep; remove subagent peerDep)
- Modify (rewire `@repo/pi-agent-ext-subagent` → `@repo/pi-agent-ext-core-runtime`): `src/workflow.ts`, `src/workflow-runtime.ts`, `src/workflow-tool.ts`, `src/workflow-manager.ts`, `src/workflow-script-parser.ts`, `src/workflow-timeout.ts`, `src/workflow-stdlib.ts`, `src/workflow-paths.ts`, `src/workflow-ui.ts`, `src/workflow-pack.ts`, `src/run-persistence.ts`, `src/task-panel.ts`, `src/display.ts`, `src/call-global.ts`, `src/host-fn-helpers.ts`, `src/workflows-models-command.ts`, `src/index.ts` (TYPE re-export block only), `extensions/workflow.ts`
- Modify: the ~11 `tests/*.ts` files importing subagent

**Interfaces:**
- Consumes: core-runtime's full public surface (Task 3).
- Produces: `pi-agent-ext-workflow` depends ONLY on `core-runtime` (no subagent edge). `new WorkflowAgent(...)` at `workflow.ts:326` resolves via the core-runtime alias.

> ⚠️ **Transient window (by design):** after Step 1 removes the subagent `peerDependencies` entry, `src/index.ts`'s runtime re-export block (deleted in Task 6) still imports `@repo/pi-agent-ext-subagent` undeclared. It resolves via Bun workspace hoisting and is cleaned up by Task 6; the dep-guard "every @repo import declared" rule is enforced at Task 7 Step 4, not here.

- [ ] **Step 1: update workflow package.json**
  - `dependencies`: add `"@repo/pi-agent-ext-core-runtime": "workspace:*"` (keep `"acorn": "^8.16.0"`).
  - `peerDependencies`: REMOVE `"@repo/pi-agent-ext-subagent": "workspace:*"` (keep pi-coding-agent, pi-tui, typebox).
  Run: `( cd bun-apps && bun install )`.

- [ ] **Step 2: rewire workflow source imports**
  Transform across the listed src + extensions files: `from "@repo/pi-agent-ext-subagent"` → `from "@repo/pi-agent-ext-core-runtime"` (symbol names unchanged). In `src/index.ts` change ONLY the TYPE re-export block (lines ~4-29); LEAVE the runtime re-export block (lines ~46-82) for Task 6. `extensions/workflow.ts:8` (flattened to root in Task 1) now also changes to `@repo/pi-agent-ext-core-runtime`.

- [ ] **Step 3: rewire workflow test imports**
  Same transform on the ~11 `tests/*.ts` files importing subagent.

- [ ] **Step 4: verify**
  Run: `grep -rn '@repo/pi-agent-ext-subagent' --include='*.ts' bun-apps/pi-agent-ext-workflow | grep -v node_modules | grep -v '/dist/'`
  Expected: only matches inside `src/index.ts` runtime re-export block (removed in Task 6), or zero.

- [ ] **Step 5: typecheck + rebuild + test**
  Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit && bun run build && bun test )`
  Expected: PASS. (Note: workflow `dist/` still references subagent until Task 6 deletes the runtime re-export block; the genuinely clean rebuild lands at Task 7 Step 3. Task 5's rebuild is fine — tests run against source, not dist.)

- [ ] **Step 6: commit**
  `git add -A && git commit -m "refactor(workflow): depend on core-runtime; drop subagent peerDep"`

---

### Task 6: Delete workflow's dead back-compat re-export block; repoint the one consumer

**Files:**
- Modify: `pi-agent-cli/src/commands/memory-to-vault.ts:21` (repoint `WorkflowAgent`)
- Modify: `bun-apps/pi-agent-ext-workflow/src/index.ts` (delete type re-export block ~4-29 + runtime re-export block ~46-82)

**Interfaces:**
- Consumes: `WorkflowAgent` via subagent facade (re-exports core-runtime alias).
- Produces: workflow public API is workflow-native only; no subagent/core-runtime re-export passthrough.

- [ ] **Step 1: repoint the single consumer**
  `pi-agent-cli/src/commands/memory-to-vault.ts:21`: split `import { runWorkflow, WorkflowAgent } from "@repo/pi-agent-ext-workflow"` into `runWorkflow` from workflow + `WorkflowAgent` from `@repo/pi-agent-ext-subagent`. If pi-agent-cli lacks a subagent dependency, add `"@repo/pi-agent-ext-subagent": "workspace:*"` to pi-agent-cli devDependencies and `( cd bun-apps && bun install )`.

- [ ] **Step 2: delete the two re-export blocks in workflow/src/index.ts**
  Remove the type re-export block (lines ~4-29) and the runtime re-export block (lines ~46-82) — both source `@repo/pi-agent-ext-subagent`. Leave all workflow-native re-exports (`from "./local.js"` etc.) intact.

- [ ] **Step 3: typecheck + test**
  Run: `( cd bun-apps/pi-agent-cli && bunx tsc --noEmit )` ; `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit && bun test )`
  Expected: PASS.

- [ ] **Step 4: commit**
  `git add -A && git commit -m "refactor(workflow): delete dead subagent re-export block; repoint WorkflowAgent consumer"`

---

### Task 7: Relocate moved-module tests; final verification

**Files:**
- Move: subagent tests covering only the 15 moved modules → `bun-apps/pi-agent-ext-core-runtime/tests/`

**Interfaces:**
- Consumes: Tasks 3-6 complete.
- Produces: green repo; core-runtime owns its tests; the `workflow → subagent` edge is gone.

- [ ] **Step 1: identify + relocate moved-module tests**
  Find subagent tests importing ONLY moved modules (grep `bun-apps/pi-agent-ext-subagent/tests` + `src/*.test.ts`). `git mv` each to `bun-apps/pi-agent-ext-core-runtime/tests/`; rewire imports → `@repo/pi-agent-ext-core-runtime`. Tests covering STAYED subagent code stay in subagent. `tests/rate-limiter-cross-pkg.test.ts` STAYS in subagent (tests cross-package resolution via subagent's re-export).

- [ ] **Step 2: run core-runtime tests**
  Run: `( cd bun-apps/pi-agent-ext-core-runtime && bun test )`
  Expected: PASS.

- [ ] **Step 3: full regression — all three packages**
```bash
( cd bun-apps/pi-agent-ext-core-runtime && bunx tsc --noEmit && bun test )
( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun test )
( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit && bun run build && bun test )
```
  Expected: all PASS.

- [ ] **Step 4: repo guards**
  Run: `( cd bun-apps && bun test tests/dep-guard.test.ts tests/seam-contract.test.ts )`
  Expected: PASS (neither hardcodes subagent as rate-limit owner; `__piRateLimitState` is `crossPackage:false`, stays non-orphan; new edges are declared and the graph stays acyclic).

- [ ] **Step 5: confirm the edge is gone**
  Run: `grep -rn '@repo/pi-agent-ext-subagent' --include='*.ts' bun-apps/pi-agent-ext-workflow | grep -v node_modules | grep -v '/dist/'`
  Expected: zero matches.

- [ ] **Step 6: commit**
  `git add -A && git commit -m "test(core-runtime): relocate moved-module tests; final verification"`

---

## Author Self-Review

- **Spec coverage:** §4.1 deep-paths → Task 1; §4.2 back-compat block → Task 6; §4.3 ordering → Tasks 1-7; §3.3 15-file move → Task 3; §3.4 stayed layer → Task 4; §3.5 CoreAgent+alias → Tasks 3-4; §5 verification → Task 7. No gaps.
- **Type consistency:** `CoreAgent` (canonical) + `WorkflowAgent` alias exported from core-runtime; both subagent and workflow import `WorkflowAgent` (alias) unchanged at call sites — no call-site renames needed.
- **Dependency direction:** `subagent → core-runtime`, `workflow → core-runtime` (both `dependencies`); core-runtime peers (pi-coding-agent, typebox, pi-ai). Acyclic. dep-guard must stay green (Task 7 Step 4).
- **Risk handled:** model-role-config/model-tier-config 7-name collision → explicit named-export barrel (Task 3 Step 3) mirroring subagent's current sourcing (behavior-preserving).
- **subagent never broken:** Task 3 copies (not moves); Task 4 rewires then deletes originals.
