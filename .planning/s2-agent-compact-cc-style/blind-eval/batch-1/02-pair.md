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

The conversation spans three sequential requests:

1. **(COMPLETED)** Execute the goal in `output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md`: (a) fix the `/goal` TUI status-bar bug via an SDK patch (FooterDataProvider.setExtensionStatus never notifies), plus a 1s heartbeat in goal.ts; (b) knowledge-layer iter-6 cross-lingual measurement (zh-TW queries vs English vault) with an adversarial lexical-overlap gate. goal_complete was called; PR #316 created.

2. **(COMPLETED)** User asked: "write next goal md -> let's focus on improve pi-agent and pi-agent deploy, improve more quality on deploy and define better pi-ext extension protocol to ensure the depoly quality and speed". Written as `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` with 9 criteria across 3 thrusts (A: deploy quality hardening, B: extension protocol v2, C: deploy speed).

3. **(IN PROGRESS)** Execute ALL items in `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md`. All 9 implementation criteria are done, but the final verification pass revealed 8 failing tests + a deploy.ts crash (fixed), and the PR (task #19) has not been created yet.

## Key Technical Concepts

- **pi-agent deploy pipeline**: 3 modes (bundle-default THIN / `--portable` FULL / `--release` source-copy). `run-dir/resolve.ts` injects absolute `-e`/`--skill` paths; works from any cwd.
- **THIN vs FULL extension bundles**: THIN externalizes typebox/`@earendil-works/*`/MCP SDK (`THIN_EXTERNALS`) and rewrites bare specifiers to absolute paths (prevents jiti data-URL/NameTooLong crash). FULL inlines everything (~10× larger).
- **Manifest schema v2**: `extensions` array now accepts declared objects `{name, entry, bundleMode, fullReason, testGate, version}` alongside bare strings (backward compat). `bundleMode` replaces the hardcoded `DEFAULT_FULL` set.
- **Bun.resolveSync vs Node createRequire**: `createRequire().resolve()` cannot resolve exports-map subpaths (e.g. `@earendil-works/pi-ai/compat`) in Bun's isolated linker tree; `Bun.resolveSync(spec, cwd)` can. This was the root cause of the web-access bundle failure.
- **3-tier build verification**: (A) factory import via mock `pi`, (B) self-verify (bare-specifier scan + factory test), (C) jiti live boot (`bun pi-agent.js -ne -e <bundle> -p "reply OK"` with `BUN_PI_LOAD_RUN_DIR=0`). Tier C is now DEFAULT for changed extensions (`--skip-live-verify` opts out).
- **Cross-extension tool-conflict detection**: mock `pi.registerTool` records (name, entryPath); same-entryPath duplicates (lazy aliases like `workflow`/`dynamic-workflows`) are excluded — only different-path duplicates are conflicts.
- **Hash cache**: per-extension hash over source tree + THIN_EXTERNALS + Bun.version; hash-match skips build+verify entirely.
- **Parallel bundling**: worker-pool (`CONCURRENCY = Math.min(exts.length, 5)`) with a shared queue; cold path 52s → 12s.
- **PATCH_TABLE registry** (from Goal 1): env-gated monkey-patches, `default: never` exhaustiveness guard.
- **FooterDataProvider bug (Goal 1)**: `setExtensionStatus` mutated the Map without notifying; fixed by patching exported `InteractiveMode.prototype.init` to wrap the instance (FooterDataProvider is NOT exported — `exports` field blocks internal imports).

## Files and Code Sections

### Goal 2 (deploy quality + ext protocol) — current uncommitted work

- **`bun-apps/pi-agent/scripts/build-extensions.ts`** (heavily modified):
  - `makeResolver(entryAbs, repoRoot)` now returns `string | undefined` (undefined = builtin; `""` = unresolved, reported): primary `Bun.resolveSync(spec, cwd)`, fallback `Bun.resolveSync(spec, repoRoot)`, last-resort createRequire package.json main-export.
  - New `isValidModuleSpec(s)`: rejects specs <2 chars or containing `[\s(){}=;<>+]` (filters minified `.from("...")` method-call artifacts).
  - `stageResolveExternals(outfile, resolveBare, thin)`: skips specs containing `${` or ` + ` (dynamic-import variables); only THROWS on unresolved when `thin` (FULL logs residual count as info).
  - Verify-stage bare scan filter: `!s.includes("${") && !s.includes(" + ") && isValidModuleSpec(s) && !isBuiltin(s) && !s.startsWith("/")`.
  - Imports `parseManifestEntries` from `../run-dir/manifest-types.ts`; `exts` entries carry `bundleMode`; thin determination is `!PORTABLE && !FULL_FOR.has(name) && spec.bundleMode !== "full"` (both in `buildOne` and the stale-cleanup `expectedFiles` map).
  - Tier C condition: `if (LIVE_VERIFY || !SKIP_LIVE_VERIFY)` (default-on for built extensions).
  - Parallel orchestration: `const CONCURRENCY = Math.min(exts.length, 5); let failed = 0, built = 0, skipped = 0;` with `worker()` functions pulling from a shared `queue` via `queue.shift()`.
- **`bun-apps/pi-agent/run-dir/manifest-types.ts`** (new): `ExtensionManifestEntry` interface + `parseManifestEntry(raw)` (bare string → `{name: derived, entry, bundleMode: "thin"}`; index.ts basename falls back to parent dir name) + `parseManifestEntries`.
- **`bun-apps/pi-agent/run-dir/manifest-types.test.ts`** (new, 7 tests, all pass).
- **`bun-apps/pi-agent/run-dir/manifest.json`**: pi-hermes-memory now a declared object with `"bundleMode": "thin"` (was full; switched after the Bun.resolveSync fix — bundle 2.97 MB → 333 KB), `fullReason` documenting the switch, `testGate`, `version: "0.80.3"`. Other 9 extensions remain bare strings.
- **`bun-apps/pi-agent/scripts/deploy.ts`**:
  - `--verify` flag: writes a probe extension to `tmpdir()`, spawns `bun <outdir>/pi-agent.js -ne -e <probe> -p verify` from `tmpdir()` (foreign cwd), parses the `[PROBE]` line, fails if no probe/ok=false. Probe uses `console.log` + `setTimeout(() => process.exit(...), 100)` to flush stdout (process.exit alone skips the flush). Verified: "47 tools, 0 conflicts".
  - Manifest v2 normalization: `const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : e.entry));` used for pkgDirs collection (fixes `rel.split is not a function`).
  - Added `import { tmpdir } from "node:os";`.
- **`bun-apps/pi-agent/scripts/verify-extensions.ts`**: added cross-extension conflict detection grouping `toolName → entryPath → [ext]` (same-path aliases excluded); `Result` type now includes `entryPath: string`; loads via `MANIFEST_ENTRIES = parseManifestEntries(MANIFEST.extensions ?? [])`. Verified "12/12 extensions loaded + wired", no conflicts.
- **`bun-apps/pi-agent/src/__tests__/extension-contract.test.ts`** (new, 5 tests, all pass): (a) factory loads, (b) wires ≥1 tool/command/event, (c) no cross-path tool conflicts, (d) tools have name/label/description, (e) commands have handler functions. Key fix: `makeMockPi` stores `onCount` on the `pi` object (`pi.onCount`) and `loadExtension` reads `mock.pi.onCount` AFTER the factory runs (earlier destructure captured a 0 snapshot).
- **`bun-apps/pi-agent/src/ext-doctor.ts`** (new): `runExtDoctor({json})` loads every manifest + lazy extension, reports OK/DYNAMIC/FAIL per extension with bundleMode·version·testGate metadata, cross-path conflict check. Wired into `src/cli.ts` via `if (argv[0] === "ext" && argv[1] === "doctor")`. Verified "12/12 extensions healthy".
- **`bun-apps/pi-agent/src/cli.ts`**: added the ext-doctor intercept after the doctor intercept.

### Goal 1 (committed via PR #316, branch feat/goal-tui-footer-notify-crosslingual-iter6)

- `bun-apps/pi-agent/src/patches/footer-extension-status-notify.ts` + `.test.ts` (9 tests): `wrapFooterDataProviderForNotify(fdp, requestRender)` + `applyFooterExtensionStatusNotifyPatch()` wrapping `InteractiveMode.prototype.init`. Registered in `patches/index.ts` PATCH_TABLE (`BUN_PI_FOOTER_EXT_STATUS_NOTIFY`).
- `bun-apps/pi-agent-ext-power-tool/src/goal/goal.ts`: 1s heartbeat (`startStatusHeartbeat`/`stopStatusHeartbeat`) managed in `updateStatus`; stopped in `clearActiveGoal`, `showCompletionStatus`, `session_shutdown`, and session_start-no-goal.
- `bun-apps/pi-agent-cli/workflows/lib/lexical-overlap-check.mjs` + `.test.ts` (17 tests): Latin tokens (≥3 chars, stopwords) + CJK bigrams overlap checker; wired into `retrieval-quality-self-improve.js` gate() (3 attempts, agent-run CLI check).
- `bun-apps/pi-agent-cli/src/commands/zk-ask.PRD.md`: iter-6 cross-lingual section + regime-guidance table (default wins all regimes; semantic-lexical = diagnostic only).
- Cross-lingual receipt: `.claude/workflows/history/retrieval-quality-self-improve/2026-07-05T22-57-51.json` (default 0.332 vs semantic-lexical 0.100, semanticLive 5/5).

## Errors and Fixes

- **web-access THIN bundle "bare specifier(s) not resolved" (`${t}`, `@earendil-works/pi-ai/compat`, ` + path + `)** — three root causes, all fixed in build-extensions.ts: (1) resolver conflated "builtin" (null) with "unresolved" (also null) so unresolved specs were silently skipped; (2) `createRequire` can't resolve exports-map subpaths in Bun's linker tree → switched to `Bun.resolveSync`; (3) dynamic-import variable patterns (`${t}`, ` + path + `) matched by the regex → excluded.
- **pi-hermes-memory FULL failed after resolver fix** (`could not resolve bare specifier(s): apiKey, ;aE$..., date-code...`) — the strict throw now applied to FULL bundles where residual bare specifiers are EXPECTED. Fix: `stageResolveExternals` takes `thin`; only throws when thin; FULL logs residuals.
- **hermes THIN then failed with minification artifacts** (`,`, `)`, `F=X.get(` etc.) — `.from("...")` method calls in minified output matched the import regex. Fix: `isValidModuleSpec()` validity filter in both resolve and verify scans.
- **deploy.ts `rel.split is not a function`** — manifest v2 object entries hit string-only code. Fixed with `extEntries` normalization. **(This fix is applied but `deploy --verify` has NOT been re-run since.)**
- **Probe output not captured** (`no [PROBE] line` despite it printing) — `process.exit()` skips stdout flush. Fix: probe uses `console.log` (synchronous flush in Bun) + `setTimeout(exit, 100)`.
- **extension-contract "zai-mcp wired nothing"** — `onCount` returned as a primitive snapshot (0) before the factory ran. Fix: store on `pi.onCount`, read after factory execution.
- **False-positive tool conflicts (workflow/dynamic-workflows)** — lazy aliases share the same entry file. Fix: group by `entryPath`; only different-path duplicates count.
- **JSDoc parse errors in lexical-overlap-check.mjs** — `/**/*.md` inside block comments contains `*/` which prematurely closes the comment. Fixed by rewording.
- **edit-tool oldText mismatches (recurring)** — tabs vs spaces, em-dashes, regex backslash escaping. Worked around with smaller targeted edits matching exact bytes.
- **UNRESOLVED — 8 test failures in pi-agent full suite (last exchange)**:
  - 4× `buildArgvFromManifest` (workspace extensions → -e pairs; skills → --skill pairs; npm extensions order; exists-predicate injection)
  - 2× `resolveRunDirArgv` integration (absolute paths exist; resolves manifest extensions)
  - 2× `applyPatches` integration (plan matches resolvePatchPlan; every PATCH_TABLE entry has a switch case)
  - Hypothesis: buildArgvFromManifest/resolveRunDirArgv failures are in `bun-apps/pi-agent/run-dir/resolve.ts` (read in Goal 1) which reads manifest.json and expects string entries — the v2 object entry for pi-hermes-memory breaks it. NOT yet diagnosed/fixed.

## Problem Solving

- Goal 1 fully solved: root-caused the SDK gap (FooterDataProvider not exported → patch via exported InteractiveMode), proved cross-lingually that semantic-lexical loses (3rd iteration of evidence), goal_complete called, PR #316 merged-pending.
- Goal 2: all 9 criteria implemented and individually verified (10/10 bundles, deploy --verify pass before the manifest-v2 deploy regression, 12/12 ext doctor, contract tests 5/5, 4.3× parallel speedup, hermes 333 KB). Remaining: fix the 8 test failures (manifest v2 ripple into resolve.ts tests + applyPatches tests), re-verify deploy --verify, final commit/PR.

## All User Messages

1. "Goal mode is active. Complete this goal fully: <goal_objective> /goal Execute the goal defined in output/next-goal-2026-07-05T21-59-06-iter6-crosslingual.md </goal_objective> Keep going until this goal is completely resolved end-to-end. Do not redefine this goal into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit this goal requirement by requirement against the verified current state. Only call the goal_complete tool after this goal is fully complete and verified."
2. "continue"
3. "write next goal md ->   let's focus on improve  pi-agent and pi-agent deploy , improve more quality on deploy and define better pi-ext extension protocol  to ensure the deploy quality and speed"
4. "Goal mode is active. Complete this goal fully: <goal_objective> execute all items defined in output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md </goal_objective> Keep going until this goal is completely resolved end-to-end. Do not redefine this goal into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit this goal requirement by requirement against the verified current state. Only call the goal_complete tool after this goal complete and verified."

## Pending Tasks

- **Fix the 8 failing pi-agent tests** (task-list #19 in_progress):
  - `buildArgvFromManifest` ×4 + `resolveRunDirArgv` integration ×2 — almost certainly `bun-apps/pi-agent/run-dir/resolve.ts` (or its test `run-dir/resolve.test.ts`) needs manifest-v2 object-entry support (normalize objects to `.entry` like deploy.ts's `extEntries`, or the tests need updating for the object entry).
  - `applyPatches` integration ×2 — diagnose; may be pre-existing or PATCH_TABLE-switch related (note: a "footer-extension-status-notify" case WAS added to the switch in Goal 1; verify the test's expected list).
- **Re-run `bun scripts/deploy.ts /tmp/... --writable --verify --no-build`** to confirm the `extEntries` fix resolves the `rel.split` crash (fix applied, not re-tested).
- **Full verification pass**: `cd bun-apps/pi-agent && bun test` all green; `bun src/cli.ts doctor` (9/9 patches); `bun src/cli.ts ext doctor` (12/12); `bun scripts/verify-extensions.ts`.
- **Commit + push + create PR** off the current branch lineage (`feat/goal-tui-footer-notify-crosslingual-iter6` contains the committed Goal-1 work; Goal-2 changes are uncommitted on top). Base main, no `--delete-branch`.
- **Audit all 9 goal criteria against verified state before goal_complete** (per the goal-objective instruction).
- Optionally: update memory with deploy/protocol insights; write the next self-reflection goal file (definition of done: "This goal file replaced by the next self-reflection").

## Current Work

The final verification pass of the deploy-quality goal (todo #19 "Final PR + contract gates" set to in_progress). The last commands run were the 4-gate check, which produced:

```
=== 1. pi-agent tests ===
 8 fail
=== 2. pi-agent ext doctor ===  ✓ 12/12 extensions healthy
=== 3. verify-extensions ===   ✓ 12/12, no conflicts
=== 4. deploy --verify ===
TypeError: rel.split is not a function. (In 'rel.split("/")', 'rel.split' is undefined)
      at bun-apps/pi-agent/scripts/deploy.ts:227
```

The deploy.ts `rel.split` error was then FIXED by adding `const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : e.entry));` and iterating `extEntries` instead of `manifest.extensions` for pkgDirs. Immediately after, the 8 failing tests were listed:

```
(fail) buildArgvFromManifest > workspace extensions → -e pairs under base, all present
(fail) buildArgvFromManifest > skills → --skill pairs under base
(fail) buildArgvFromManifest > npm extensions appended AFTER workspace extensions
(fail) buildArgvFromManifest > uses the injected exists predicate (not real fs)...
(fail) resolveRunDirArgv (integration, source mode against the real repo) > every returned path is absolute and exists on disk
(fail) resolveRunDirArgv (integration...) > resolves at least the manifest's workspace extensions + skills
(fail) applyPatches (integration) > returns the same plan as resolvePatchPlan for the live env
(fail) applyPatches (integration) > every PATCH_TABLE entry has a switch case (no unhandled patch)
```

The conversation ended immediately after listing these — no diagnosis or fix has been attempted yet.

## Optional Next Step

Diagnose and fix the 8 test failures, starting with the most likely shared root cause: `bun-apps/pi-agent/run-dir/resolve.ts` and its test `bun-apps/pi-agent/run-dir/resolve.test.ts` still expect `manifest.extensions` to be bare strings, but the manifest v2 migration made pi-hermes-memory a declared object (`{"name": "pi-hermes-memory", "entry": ..., "bundleMode": "thin", ...}`). Mirror the deploy.ts fix — normalize with `parseManifestEntries(...).map(e => e.entry)` (or equivalent) wherever `manifest.extensions` is consumed. Then check the two `applyPatches` integration failures (read `src/patches/index.test.ts` to see if its expected-plan assertions need the new patch/env or whether the failures are environmental). After all tests are green, re-run `bun scripts/deploy.ts /tmp/<dir> --writable --verify --no-build` to confirm the `extEntries` fix, run the full audit of all 9 criteria, commit, push, create the PR, and call goal_complete.



## Summary Y

## Goal

Execute all items defined in `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` — pi-agent deploy quality hardening + pi-ext extension protocol v2. The 9 criteria:

1. Fix web-access THIN bundle failure (bare specifiers: `${t}`, `@earendil-works/pi-ai/compat`)
2. Add `deploy --verify` end-to-end smoke (boot deployed artifact + probe getAllTools from foreign cwd)
3. Add cross-extension tool-conflict detection to `verify-extensions.ts`
4. Make jiti tier C verify default for CHANGED extensions (hash-matched still skip)
5. Manifest schema v2 (declared entries: name/entry/bundleMode/testGate/version, backward compat for bare strings)
6. Add `extension-contract.test.ts` (factory loads, wired, no conflicts, valid schemas, handlers)
7. Add `pi-agent ext doctor` subcommand
8. Parallelize extension bundling (cold deploy <50% of sequential time)
9. Slim pi-hermes-memory FULL bundle (2.97 MB → <1 MB)

Then: run contract gates, create PR off main (no `--delete-branch`), write next-goal self-reflection, call goal_complete.

## Constraints & Preferences

- Goal mode is active: complete fully end-to-end, no partial fixes, audit every criterion before goal_complete
- PR must be off main; no `--delete-branch` on merge
- Worktree/test output is authoritative; if tool fails, try alternatives
- Repo convention: `date -u +%Y-%m-%dT%H-%M-%S` for goal filenames

## Progress

### Done

- [x] **Criterion 1 — web-access THIN fix**: Root cause was 3 bugs in `bun-apps/pi-agent/scripts/build-extensions.ts`:
  - `makeResolver` returned `null` for BOTH builtins and unresolved (silent skip bug) → now returns `undefined` for builtins, `""` for unresolved
  - Node's `createRequire` can't resolve exports-map subpaths (`@earendil-works/pi-ai/compat`) in Bun's isolated linker tree → replaced with `Bun.resolveSync(spec, cwd)` primary + repo-root fallback + createRequire last resort. New signature: `makeResolver(entryAbs, repoRoot)`
  - Regex matched dynamic-import variables (`${t}`, ` + path + `) → excluded via `spec.includes("${")` / `spec.includes(" + ")`
  - Also added `isValidModuleSpec(s)` filter (length ≥2, no code chars `[\s(){}=;<>+]`) to exclude `.from("...")` method-call minification artifacts
  - FULL bundles: unresolved residuals now LOG not throw (`thin` param passed to `stageResolveExternals(outfile, resolver, thin)`)
  - Result: 10/10 extensions bundle, deploy exits 0
- [x] **Criterion 3 — tool-conflict gate**: `verify-extensions.ts` now tracks toolName → Map<entryPath, extNames[]>; conflicts only when DIFFERENT entry paths (same-file lazy aliases like `workflow`/`dynamic-workflows` excluded). Added `entryPath` to Result type. 12/12 pass, no false positives
- [x] **Criterion 2 — deploy --verify**: Added `--verify` flag to `deploy.ts`; writes probe ext to tmpdir, boots `bun <outdir>/pi-agent.js -ne -e <probe> -p` from foreign cwd, checks `[PROBE]` line for toolCount>0 + no dupes. Probe uses `console.log` + `setTimeout(...,100)` before exit (process.exit skips stdout flush). Verified: "47 tools, 0 conflicts"
- [x] **Criterion 4 — jiti default for changed**: tier C in `stageVerify` now runs when `LIVE_VERIFY || !SKIP_LIVE_VERIFY`; added `--skip-live-verify` opt-out flag
- [x] **Criterion 5 — manifest v2**: New `bun-apps/pi-agent/run-dir/manifest-types.ts` (`parseManifestEntry`/`parseManifestEntries`, `ExtensionManifestEntry` interface) + `manifest-types.test.ts` (7 tests pass). `manifest.json` now has pi-hermes-memory as declared object. `build-extensions.ts` reads `bundleMode` from manifest (replaces hardcoded `DEFAULT_FULL` set — note `DEFAULT_FULL` set may still exist unused). `verify-extensions.ts` uses `MANIFEST_ENTRIES`
- [x] **Criterion 6 — extension-contract.test.ts**: `bun-apps/pi-agent/src/__tests__/extension-contract.test.ts` with tests (a)-(e). Fixed mock-pi bug: `onCount` must be read from `mock.pi.onCount` AFTER factory runs (primitive snapshot bug). All 5 tests pass
- [x] **Criterion 7 — ext doctor**: New `bun-apps/pi-agent/src/ext-doctor.ts` + intercept in cli.ts (`argv[0]==="ext" && argv[1]==="doctor"`). Reports per-ext status (OK/DYN/FAIL), bundleMode/version/testGate, tool-conflict check with same-file dedup. 12/12 healthy
- [x] **Criterion 8 — parallel builds**: Worker-pool pattern (CONCURRENCY = min(exts.length, 5)), `queue.shift()` workers, results aggregated. Cold path: 52s → 12s (4.3x speedup, 23% of original — well under 50% target)
- [x] **Criterion 9 — hermes slim**: Switched hermes to `bundleMode: "thin"` in manifest (works due to criterion-1 Bun.resolveSync fix). 2.97 MB FULL → **333 KB THIN** (89% reduction). Passes live jiti verify

### In Progress

- [ ] **Fixing 8 test failures** introduced by the manifest v2 change (current blocker):
  - `buildArgvFromManifest` tests (4 fail): workspace extensions → -e pairs, skills → --skill pairs, npm extensions ordering, injected exists predicate — these test `bun-apps/pi-agent/run-dir/resolve.ts`'s `buildArgvFromManifest` which expects string[] `manifest.extensions` and breaks on object entries
  - `resolveRunDirArgv` integration tests (2 fail): absolute paths / manifest extensions resolution
  - `applyPatches` integration tests (2 fail): "returns the same plan as resolvePatchPlan for the live env", "every PATCH_TABLE entry has a switch case" — likely manifest parsing in `run-dir/resolve.ts` imports manifest.json and fails on the object entry
  - **Fix needed**: update `bun-apps/pi-agent/run-dir/resolve.ts` (and/or its `buildArgvFromManifest` + tests in `resolve.test.ts`) to normalize object entries via `parseManifestEntries`/`e.entry` before splitting

### Blocked

- **Deploy error fixed but unverified**: `deploy.ts` was fixed (normalizes `e.entry` from object entries in extEntries) but the final `deploy --verify` run hasn't been re-run after the fix
- Test suite must go green (0 fail) before PR

## Key Decisions

- **Bun.resolveSync over createRequire**: Node CJS resolution can't handle exports-map subpaths in Bun's isolated linker; Bun's own resolver can
- **THIN for hermes**: original FULL reason (unresolvable compat subpath) is now fixed; better-sqlite3 stays as residual bare specifier in both modes
- **Same-file alias exclusion for conflict detection**: lazy aliases pointing to the same entry file are NOT conflicts
- **Same-file dedup uses `entryPath`**: recorded in Result during loadOne
- **Parallelism limit 5**: each jiti boot spawns pi-agent.js (~200MB RSS); 5 concurrent is safe
- **Probe flush**: `console.log` + setTimeout-100 before process.exit (exit skips stdout flush)

## Next Steps

1. **Fix the 8 failing tests**: update `bun-apps/pi-agent/run-dir/resolve.ts` to handle manifest v2 object entries (normalize via `parseManifestEntries` from `run-dir/manifest-types.ts`, then `e.entry`) — check `resolve.test.ts`'s `buildArgvFromManifest` tests which likely feed raw manifest arrays
2. Re-run `bun test` in `bun-apps/pi-agent` until 0 fail (expect ~223 tests across 15 files)
3. Re-run `bun scripts/deploy.ts /tmp/final-deploy-test --writable --verify --no-build` to confirm the deploy fix works end-to-end
4. Run all contract gates: pi-agent tests, `ext doctor`, `verify-extensions.ts`, power-tool tests (24), pi-agent-cli tests (215)
5. Git: create branch (e.g., `feat/deploy-quality-ext-protocol`), stage ONLY the relevant files: `build-extensions.ts`, `deploy.ts`, `verify-extensions.ts`, `manifest.json`, `manifest-types.ts`, `manifest-types.test.ts`, `extension-contract.test.ts`, `ext-doctor.ts`, `cli.ts`, `resolve.ts` (if changed), test files
6. Commit, push, create PR off main (no `--delete-branch`)
7. Update memory with key insights (Bun.resolveSync vs createRequire, manifest v2 schema)
8. Write next-goal self-reflection file (replace `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` per convention), delete old goal file
9. Audit all 9 criteria against verified state, then call `goal_complete`

## Critical Context

- **Goal file**: `output/next-goal-2026-07-06T00-10-00-deploy-quality-ext-protocol.md` (13KB, contains all 9 criteria + definition of done)
- **Failing test file**: `bun-apps/pi-agent/run-dir/resolve.test.ts` — `buildArgvFromManifest` reads `manifest.extensions` as string[]
- **Manifest v2 example entry**: `{"name": "pi-hermes-memory", "entry": "pi-hermes-memory/src/index.ts", "bundleMode": "thin", "fullReason": "...", "testGate": "cd bun-apps/pi-hermes-memory && bun test", "version": "0.80.3"}`
- **Key files modified**: `bun-apps/pi-agent/scripts/build-extensions.ts`, `bun-apps/pi-agent/scripts/deploy.ts`, `bun-apps/pi-agent/scripts/verify-extensions.ts`, `bun-apps/pi-agent/run-dir/manifest.json`, `bun-apps/pi-agent/run-dir/manifest-types.ts` (new), `bun-apps/pi-agent/run-dir/manifest-types.test.ts` (new), `bun-apps/pi-agent/src/__tests__/extension-contract.test.ts` (new), `bun-apps/pi-agent/src/ext-doctor.ts` (new), `bun-apps/pi-agent/src/cli.ts`
- **Baseline test counts**: pi-agent should have ~223 tests (211 original + 7 manifest-types + 5 contract); was "8 fail / 362 expect" at last run
- **Timing baselines**: cold build-extensions 52s sequential → 12s parallel; warm ~0.6s; hermes bundle 2.97MB→333KB
- **Branch state**: on `feat/goal-tui-footer-notify-crosslingual-iter6` (iter-6 work committed, PR #316 open). New work is uncommitted on top. Need new branch for this goal
- **Previous goal (iter-6) already completed** with goal_complete called; this is a NEW goal activated after
