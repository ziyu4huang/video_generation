# Pair 02 — blind eval (score before opening key.json)

## Fact set (deterministic ground truth both summaries should recall)

Paths:
- /Users/huangziyu/.bun/install/cache/@earendil-works/pi-coding-agent@0.80.3@@@1/dist/core/footer-data-provider.js
- /Users/huangziyu/.bun/install/cache/@earendil-works/pi-coding-agent@0.80.3@@@1/dist/modes/interactive/components/footer.js
- /Users/huangziyu/.bun/install/cache/@earendil-works/pi-coding-agent@0.80.3@@@1/dist/modes/interactive/interactive-mode.js
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/src/commands/zk-ask.PRD.md
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/workflows/retrieval-quality-self-improve.js
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-ext-power-tool/src/goal/goal.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest.json
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/build-extensions.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/deploy.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/verify-extensions.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/cli.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/ext-context-get-system-prompt-options.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/ext-context-get-system-prompt-options.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/index.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/index.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/pre-load-providers.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-dynamic-workflows/src/workflow.ts
- /Users/huangziyu/proj/video_generation__pi/output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/src/commands/zk-ask.PRD.md
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/workflows/lib/lexical-overlap-check.mjs
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/workflows/retrieval-quality-self-improve.js
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-ext-power-tool/src/goal/goal.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest-types.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest.json
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/build-extensions.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/deploy.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/scripts/verify-extensions.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/__tests__/extension-contract.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/cli.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/ext-doctor.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/index.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/index.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/workflows/lib/lexical-overlap-check.mjs
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent-cli/workflows/lib/lexical-overlap-check.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest-types.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest-types.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/run-dir/manifest.json
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/__tests__/extension-contract.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/ext-doctor.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/footer-extension-status-notify.test.ts
- /Users/huangziyu/proj/video_generation__pi/bun-apps/pi-agent/src/patches/footer-extension-status-notify.ts
- /Users/huangziyu/proj/video_generation__pi/output/next-goal-2026-07-05T23-57-10-iter7-embedding-ab.md
- /Users/huangziyu/proj/video_generation__pi/output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md

User requests:
- Goal mode is active. Complete this goal fully:

<goal_objective>
/goal Execute the goal defined in output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md
</goal_objective>

Keep going until this g
- continue
- write next goal md ->   let's focus on improve  pi-agent and pi-agent deploy , improve more quality on deploy and define better pi-ext extension protocol  to ensure the depoly quality and speed
- Goal mode is active. Complete this goal fully:

<goal_objective>
execute all items defined in output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md
</goal_objective>

Keep going until th

Error strings:
- {"role":"toolResult","toolCallId":"call_00_ln05gVHjay2wD29a1dPO9784","toolName":"read","content":[{"type":"text","text":"/**\n * ext-context
- {"role":"toolResult","toolCallId":"call_c0db5292d89445ab9a4283c0","toolName":"read","content":[{"type":"text","text":"/**\n * goal tool + /g
- {"role":"assistant","content":[{"type":"thinking","thinking":"Now I understand the test pattern. The tests import the patch module (which ap
- {"role":"assistant","content":[{"type":"text","text":"Now let me write the patch file:"},{"type":"toolCall","id":"call_d1ae14d1caed4d9ea259f
- {"role":"toolResult","toolCallId":"call_e186ec7cd66d4917aa594baf","toolName":"bash","content":[{"type":"text","text":"(pass) resolveEnvBridg
- {"role":"assistant","content":[{"type":"thinking","thinking":"One test failed: \"PATCH_TABLE > covers all known patches\". I need to update 
- {"role":"toolResult","toolCallId":"call_f36921535f6646c280a8e3ff","toolName":"read","content":[{"type":"text","text":"// @ts-nocheck\n/**\n 
- {"role":"toolResult","toolCallId":"call_03e87dd89c274cd2a13c073e","toolName":"bash","content":[{"type":"text","text":"bun test v1.3.14 (0d9b
- {"role":"toolResult","toolCallId":"call_820cfe24990c494eb0a304df","toolName":"bash","content":[{"type":"text","text":"bun test v1.3.14 (0d9b
- {"role":"toolResult","toolCallId":"call_08e770fc28f14cc6a4a6efc2","toolName":"read","content":[{"type":"text","text":"   to sample what card

## Summary X



## Primary Request and Intent

The session covers three sequential goals:

1. **(COMPLETED)** Execute `output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md`: fix the `/goal` TUI status-bar bug via SDK patch + run knowledge-layer iter-6 cross-lingual retrieval measurement. Goal was completed and `goal_complete` called.

2. **(COMPLETED)** User asked: "write next goal md -> let's focus on improve pi-agent and pi-agent deploy, improve more quality on deploy and define better pi-ext extension protocol to ensure the deploy quality and speed". Next-goal file written: `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md`.

3. **(ACTIVE — in progress)** "execute all items defined in output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md" — 9 criteria covering deploy quality hardening (Thrust A), extension protocol v2 (Thrust B), and deploy speed (Thrust C). Criteria 1-9 are implemented but the final contract gates have **8 failing tests** that must be fixed before PR + goal_complete.

## Key Technical Concepts

- **pi-coding-agent SDK** (`@earendil-works/pi-coding-agent@0.80.3`): `FooterDataProvider`, `InteractiveMode`, extension API, jiti loader
- **Patch system**: `PATCH_TABLE` in `src/patches/index.ts` with env gates, static-literal imports for bun bundling
- **THIN vs FULL extension bundles**: THIN externalizes typebox/@earendil-works/* (shared deps via abs-path rewriting); FULL inlines everything
- **Bare specifier abs-resolution**: rewriting `from "pkg"` → `from "/abs/path"` so jiti doesn't wrap in data:URL (NameTooLong crash)
- **`Bun.resolveSync` vs Node `createRequire`**: Bun.resolveSync handles exports maps correctly in Bun's isolated linker tree; createRequire cannot resolve deep subpaths like `@earendil-works/pi-ai/compat`
- **Hash cache**: extension source-tree hash + THIN_EXTERNALS + Bun.version → warm-build skip
- **Manifest schema v2**: declared objects `{name, entry, bundleMode, fullReason, testGate, version}` with backward compat for bare strings
- **3-tier verify**: factory import → self-verify → jiti live boot (`bun pi-agent.js -ne -e <bundle> -p`)
- **Concurrency-limited worker pool** for parallel builds (CONCURRENCY=5)

## Files and Code Sections

**Created this session (verified in <verified-files> Written list):**
- `bun-apps/pi-agent/src/patches/footer-extension-status-notify.ts` + `.test.ts` — wraps `InteractiveMode.prototype.init` to add `onExtensionStatusChange`/`notifyExtensionStatusChange` + `requestRender`. 9 tests.
- `bun-apps/pi-agent-cli/workflows/lib/lexical-overlap-check.mjs` + `.test.ts` — CJK bigrams + Latin tokens, 17 tests
- `bun-apps/pi-agent/run-dir/manifest-types.ts` + `manifest-types.test.ts` — `ExtensionManifestEntry`, `parseManifestEntry`, `parseManifestEntries`. 7 tests.
- `bun-apps/pi-agent/src/__tests__/extension-contract.test.ts` — 5 contract checks (factory loads, wires up, no conflicts, valid tool metadata, command handlers)
- `bun-apps/pi-agent/src/ext-doctor.ts` — `runExtDoctor()` per-extension health report
- `output/next-goal-2026-07-05T23-57-10-iter7-embedding-ab.md` (iter-7 goal, superseded)
- `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` (CURRENT goal)

**Modified:**
- `bun-apps/pi-agent/scripts/build-extensions.ts` — major changes: `makeResolver(entryAbs, repoRoot)` now uses `Bun.resolveSync` primary + createRequire fallback, returns `undefined` for builtins / `""` for unresolved; `stageResolveExternals(outfile, resolveBare, thin)` only throws on unresolved for THIN (FULL logs); added `isValidModuleSpec(s)` filter excluding specs with code chars `[\\s(){}=;<>+]` or length <2; added `--skip-live-verify` flag making tier C default for built extensions; parallelized build loop with `CONCURRENCY = Math.min(exts.length, 5)` worker pool; manifest parsing uses `parseManifestEntries`, `spec.bundleMode !== "full"` replaces `DEFAULT_FULL`
- `bun-apps/pi-agent/scripts/deploy.ts` — added `--verify` flag + `VERIFY` const; probe writes to `join(tmpdir(), ...)` boots from foreign cwd with `console.log("[PROBE] ...")` + `setTimeout(() => process.exit())`; manifest parsing normalized: `const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : e.entry))`; added `import { tmpdir } from "node:os"`
- `bun-apps/pi-agent/scripts/verify-extensions.ts` — added cross-extension tool-conflict detection with `toolOwners: Map<string, Map<string, string[]>>` (toolName → entryPath → exts), same-file alias exclusion; `Result` type gained `entryPath`; uses `parseManifestEntries`
- `bun-apps/pi-agent/run-dir/manifest.json` — pi-hermes-memory now declared object with `"bundleMode": "thin"` (was "full", changed for criterion 9)
- `bun-apps/pi-agent/src/cli.ts` — added `ext doctor` intercept: `if (argv[0] === "ext" && argv[1] === "doctor")` → dynamic import `runExtDoctor`
- `bun-apps/pi-agent-ext-power-tool/src/goal/goal.ts` — added `statusHeartbeatTimer`/`heartbeatCtx`, `startStatusHeartbeat(ctx, goal)` 1s interval recomputing `active <elapsed>`, `stopStatusHeartbeat()` hooked into `updateStatus`/`clearActiveGoal`/`showCompletionStatus`/`session_shutdown`/`session_start`
- `bun-apps/pi-agent/src/patches/index.ts` + `index.test.ts` — registered `footer-extension-status-notify` patch
- `bun-apps/pi-agent-cli/workflows/retrieval-quality-self-improve.js` — gate() now runs overlap-check via agent+Bash, attempts: 3
- `bun-apps/pi-agent-cli/src/commands/zk-ask.PRD.md` — added Cross-lingual regime test section + Regime guidance summary table

## Errors and fixes

1. **web-access THIN bundle failure** (`bare specifier(s) not resolved: ${t}, @earendil-works/pi-ai/compat, + path +`):
   - Root cause 1: `makeResolver` returned `null` for BOTH builtins and unresolved → caller's `if (abs === null) continue` silently skipped unresolved. Fixed: `undefined` = builtin, `""` = unresolved (reported).
   - Root cause 2: Node `createRequire().resolve("@earendil-works/pi-ai/compat")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` in Bun's isolated linker tree despite the exports map containing `./compat`. Fixed: `Bun.resolveSync(spec, cwd)` primary.
   - Root cause 3: `${t}` and ` + path + ` are dynamic-import variable interpolations caught by regex. Fixed: `if (spec.includes("${") || spec.includes(" + ")) continue`.

2. **pi-hermes-memory FULL broke after resolver fix** (minified artifacts like `apiKey`, date code matched as specifiers): stage 1b was throwing on unresolved for FULL bundles. Fixed: only THIN throws; FULL logs "N residual bare specifier(s) (resolve at runtime via host node_modules)".

3. **hermes THIN hit minified `.from("...")` method-call false positives** (specs like `,`, `F=X.get(`): Added `isValidModuleSpec(s)` — length ≥2, no `[\\s(){}=;<>+]` chars. Result: hermes THIN = 333 KB (was 2.97 MB FULL).

4. **deploy --verify stdout race**: probe's `process.stdout.write` + immediate `process.exit()` skipped the flush — `[PROBE]` line appeared after the error message. Fixed: probe uses `console.log` + `setTimeout(() => process.exit(ok ? 0 : 1), 100)`.

5. **extension-contract mock bug**: `onCount` returned as snapshot primitive (0) before factory ran; factory incremented the orphaned closure. Fixed: `onCount` lives on `pi` object; `loadExtension` reads `mock.pi.onCount` AFTER factory runs.

6. **Lazy-alias conflict false positives** (`workflow` + `dynamic-workflows` → same file): conflict detection now keys by entry path (`Map<toolName, Map<entryPath, string[]>>`); same-path = alias, not conflict.

7. **deploy.ts `rel.split is not a function`** (manifest v2 objects): Fixed by normalizing `extEntries = manifest.extensions.map(e => typeof e === "string" ? e : e.entry)`.

8. **🔴 UNRESOLVED — 8 pi-agent test failures** after manifest v2 change:
   - `buildArgvFromManifest > workspace extensions → -e pairs under base, all present`
   - `buildArgvFromManifest > skills → --skill pairs under base`
   - `buildArgvFromManifest > npm extensions appended AFTER workspace extensions`
   - `buildArgvFromManifest > uses the injected exists predicate (not real fs)`
   - `resolveRunDirArgv (integration, source mode)` × 2
   - `applyPatches (integration)` × 2
   
   Hypothesis: `run-dir/resolve.ts` imports manifest.json directly and iterates `extensions` expecting strings — object entries (pi-hermes-memory) break it. `src/patches/index.test.ts` applyPatches failures may be the `resolveRunDirArgv` dependency or a separate patch-plan issue.

## Problem Solving

- Confirmed `/goal` TUI root cause via SDK source reading (footer-data-provider.js:127 `setExtensionStatus` has no notify; interactive-mode.js:521 only subscribes `onBranchChange`)
- FooterDataProvider is NOT exported (exports field blocks internal imports) — patched via exported `InteractiveMode` instance instead
- Cross-lingual measurement (run `2026-07-05T22-57-51`): default 0.332 vs semantic-lexical 0.100, `semanticLive=5/5` — refutes the predicted cross-lingual win zone; graph expansion bridges languages better than semantic vectors
- Cold-build parallelization: 52s → 12s (4.3×) with 5-worker pool
- hermes bundle: 2.97 MB → 333 KB (89% reduction) by switching to THIN after the resolver fix removed the original FULL justification

## All user messages

1. "Goal mode is active. Complete this goal fully: <goal_objective>/goal Execute the goal defined in output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md</goal_objective> Keep going until this goal is completely resolved end-to-end. Do not redefine this goal into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit this goal requirement by requirement against the verified current state. Only call the goal_complete tool after this goal is fully complete and verified."

2. "continue"

3. "write next goal md ->   let's focus on improve  pi-agent and pi-agent deploy , improve more quality on deploy and define better pi-ext extension protocol  to ensure the deploy quality and speed"

4. "Goal mode is active. Complete this goal fully: <goal_objective>execute all items defined in output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md</goal_objective> Keep going until this goal is completely resolved end-to-end. Do not redefine this goal into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are available when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit this goal requirement by requirement against the verified current state. Only call the goal_complete tool after this goal is fully complete and verified."

## Pending Tasks

1. **🔴 Fix the 8 failing pi-agent tests** — `buildArgvFromManifest` (4) + `resolveRunDirArgv` integration (2) in `run-dir/resolve.test.ts`, and `applyPatches` integration (2) in `src/patches/index.test.ts`. Root cause hypothesis: `run-dir/resolve.ts` iterates `manifest.extensions` expecting strings; manifest v2 object entries (pi-hermes-memory) break `buildArgvFromManifest`. Fix: normalize entries via `parseManifestEntries` in resolve.ts (or update the tests).
2. **Re-verify the full test suite green** (`cd bun-apps/pi-agent && bun test` → 0 fail)
3. **Re-verify deploy --verify end-to-end** (was broken by manifest v2, deploy.ts fix applied but not yet re-run)
4. **Final PR** off main, no `--delete-branch` (todo #19 "Final PR + contract gates" is in_progress)
5. **Memory update** with session learnings
6. **Audit all 9 goal criteria** against verified state before `goal_complete`
7. Optionally write next self-reflection goal file (per the goal's definition of done: "This goal file replaced by the next self-reflection")

## Current Work

Executing goal #4 (deploy quality + extension protocol). All 9 implementation criteria are coded and individually verified:
- Criterion 1 ✅ (10/10 extensions bundle)
- Criterion 2 ✅ (deploy --verify: 47 tools, 0 conflicts — but needs re-run after the deploy.ts manifest fix)
- Criterion 3 ✅ (12/12, no conflicts)
- Criterion 4 ✅ (jiti default, "pi-agent booted, bundle loaded under jiti")
- Criterion 5 ✅ (7 manifest-types tests pass)
- Criterion 6 ✅ (5 contract tests pass)
- Criterion 7 ✅ (`pi-agent ext doctor`: 12/12 healthy)
- Criterion 8 ✅ (52s → 12s cold build)
- Criterion 9 ✅ (hermes 2.97 MB → 333 KB)

The very last actions: fixed `deploy.ts` manifest v2 normalization (`extEntries` mapping for the `rel.split` crash), then ran the final contract gate check which revealed **8 test failures**:
```
(fail) buildArgvFromManifest > workspace extensions → -e pairs under base, all present
(fail) buildArgvFromManifest > skills → --skill pairs under base
(fail) buildArgvFromManifest > npm extensions appended AFTER workspace extensions
(fail) buildArgvFromManifest > uses the injected exists predicate (not real fs)
(fail) resolveRunDirArgv (integration, source mode against the real repo) > every returned path is absolute and exists on disk
(fail) resolveRunDirArgv (integration, source mode against the real repo) > resolves at least the manifest's workspace extensions + skills
(fail) applyPatches (integration) > returns the same plan as resolvePatchPlan for the live env
(fail) applyPatches (integration) > every PATCH_TABLE entry has a switch case (no unhandled patch)
```
These are the immediate blocker before the final PR and `goal_complete`.

## Optional Next Step

Fix the 8 failing tests, starting with `run-dir/resolve.ts`'s manifest consumption. Concretely:
1. Read `bun-apps/pi-agent/run-dir/resolve.ts` to find where it iterates `manifest.extensions` (grep for `manifest` / `extensions`), and either normalize object entries to their `entry` string (mirroring the deploy.ts fix: `typeof e === "string" ? e : e.entry`) or adopt `parseManifestEntries` from `run-dir/manifest-types.ts`.
2. Re-run `cd bun-apps/pi-agent && bun test` and inspect the 2 `applyPatches (integration)` failures separately (may be an env-dependent patch-plan mismatch, not manifest-related — check whether they fail on a clean checkout too).
3. Once green, re-run `bun scripts/deploy.ts /tmp/<dir> --writable --verify --no-build`, then complete todo #19: commit on a new branch off main, push, `gh pr create` (no `--delete-branch`), update memory, audit all 9 criteria, and call `goal_complete`.



## Summary Y

## Goal
Execute all items in `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` — pi-agent deploy quality hardening + pi-ext extension protocol v2 (9 criteria: web-access bundle fix, deploy --verify, tool-conflict gate, jiti default-for-changed, manifest schema v2, extension-contract test, `ext doctor` subcommand, parallel bundling, hermes-memory slim), then final PR + contract gates.

## Constraints & Preferences
- Complete end-to-end autonomously; don't stop at plans/partial fixes
- Contract gates green; PR off main; no `--delete-branch`
- TUI verification by eye deferred; unit-test-level verification acceptable

## Progress
### Done
- [x] **Criterion 1** (web-access THIN fix): `makeResolver` now uses `Bun.resolveSync` (handles exports maps; Node `createRequire` can't resolve `@earendil-works/pi-ai/compat` in Bun linker tree); fixed null-vs-unresolved resolver bug (returns `undefined`=builtin, `""`=unresolved); excluded dynamic-import variable artifacts (`${t}`, ` + path + `) from regex scans; FULL bundles no longer throw on residual bare specifiers (log-only)
- [x] **Criterion 3** (tool-conflict gate): `verify-extensions.ts` tracks toolName → entryPath → [exts]; same-file lazy aliases (`workflow`/`dynamic-workflows`) excluded; 12/12 pass
- [x] **Criterion 2** (deploy --verify): added `--verify` flag to `deploy.ts` — boots deployed pi-agent.js from foreign cwd with a probe extension calling `pi.getAllTools()`; probe uses `console.log` + `setTimeout(exit,100)` to flush; verified: 47 tools, 0 conflicts
- [x] **Criterion 4** (jiti default): tier C runs by default for changed extensions; `--skip-live-verify` opt-out added
- [x] **Criterion 5** (manifest v2): new `run-dir/manifest-types.ts` (parseManifestEntry/parseManifestEntries, backward-compat bare strings) + 7 unit tests; manifest.json migrated pi-hermes-memory to declared object; build-extensions reads `bundleMode` from manifest (replaced hardcoded `DEFAULT_FULL`)
- [x] **Criterion 6** (contract test): `src/__tests__/extension-contract.test.ts` — 5 checks (loads, wires, no conflicts, tool metadata, command handlers); fixed onCount snapshot bug (read `mock.pi.onCount` after factory)
- [x] **Criterion 7** (`ext doctor`): `src/ext-doctor.ts` + cli.ts intercept (`ext doctor [--json]`); 12/12 healthy; same-file dedup for conflicts
- [x] **Criterion 8** (parallel builds): concurrency-5 worker pool; cold `--force` path 52s → 12s (4.3×)
- [x] **Criterion 9** (hermes slim): switched to THIN after Bun.resolveSync fix + added `isValidModuleSpec()` filter (rejects specs with code chars/whitespace, <2 chars); 2.97 MB FULL → **333 KB THIN**
- [x] Fixed `deploy.ts` manifest v2 compat: normalized object entries via `.entry` (fixed `rel.split is not a function`)

### In Progress
- [ ] **8 test failures in pi-agent suite** (last discovered): `buildArgvFromManifest` (4 fails: workspace extensions, skills, npm extensions order, exists-predicate), `resolveRunDirArgv` integration (2 fails: absolute paths, resolves extensions+skills), `applyPatches` integration (2 fails). Root cause: these tests read manifest.json directly and expect all-string `extensions` — need v2 normalization (likely in `run-dir/resolve.ts` and/or test fixtures)

### Blocked
- None (test failures are the immediate work item)

## Key Decisions
- **Bun.resolveSync over createRequire**: Node's CJS resolver can't resolve exports-map subpaths (e.g. `pi-ai/compat`) in Bun's isolated linker tree
- **THIN for hermes-memory**: original FULL reason (unresolvable compat + native sqlite) invalidated by resolver fix; better-sqlite3 stays as residual bare specifier
- **Same-file lazy aliases are not tool conflicts**: dedupe by resolved entry path
- **FULL bundles log (not throw) on residual bare specifiers**: they're expected to resolve via host node_modules at runtime

## Next Steps
1. Fix the 8 failing tests: normalize manifest v2 entries in `run-dir/resolve.ts` (`buildArgvFromManifest`) and any test fixtures that parse manifest.json directly (convert object entries to `.entry` strings or use parseManifestEntries)
2. Re-run full suites: `cd bun-apps/pi-agent && bun test` (expect 0 fail); verify-extensions; `ext doctor`; `deploy --verify`
3. Commit on branch (was previously on `feat/goal-tui-footer-notify-crosslingual-iter6` — check git status; may need new branch off it, e.g. `feat/deploy-quality-ext-protocol`), push, create PR off main
4. Run final criterion audit against the goal doc's Definition of Done; memory update; write next-goal self-reflection + delete old goal file; call goal_complete

## Critical Context
- Goal file: `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md`
- Manifest: `bun-apps/pi-agent/run-dir/manifest.json` — now mixed strings + one declared object (pi-hermes-memory, `bundleMode: "thin"`)
- Failing test files to inspect: `bun-apps/pi-agent/run-dir/resolve.test.ts` (buildArgvFromManifest, resolveRunDirArgv), `bun-apps/pi-agent/src/patches/index.test.ts` (applyPatches integration — likely fails because resolveRunDirArgv/manifest reading fails first)
- Key scripts: `scripts/build-extensions.ts`, `scripts/deploy.ts` (`--verify`), `scripts/verify-extensions.ts`, `src/ext-doctor.ts`, `run-dir/manifest-types.ts`(+test), `src/__tests__/extension-contract.test.ts`
- Baselines: cold `--force` build 12s; hermes 333 KB THIN; ext doctor 12/12 healthy; deploy --verify 47 tools 0 conflicts
- Repo: `/Users/huangziyu/proj/video_generation__pi`; PR #316 (iter-6) exists on `feat/goal-tui-footer-notify-crosslingual-iter6`
