# workflow-pack regression audit — finding docket (2026-07-18)

Branch: `workflow-pack-regression-buildup`. 9-dimension read-only fan-out audit, each finding **hand-verified against source by the controller**. Defects marked ✅ confirmed / ⚠️ partial / ❌ discarded.

## Totals

| Grade (controller-assigned) | Count | Action |
|---|---|---|
| Defect — clear low-risk fix (no return-shape change) | 6 | fix + guard (Task 6) |
| Defect — contract change (needs user confirm) | 6 | **escalate** (this doc §3) |
| Defect — out of scope / platform | 1 | defer (.todo + issue) |
| Coverage gap — pin current behavior | 41 | guard only (Task 6) |
| **Total raw findings** | **54** | |

## 1. Confirmed defects — clear low-risk fix (6)

| ID | File:line | What | Fix shape |
|---|---|---|---|
| **D2-1** ✅ | `workflow-pack-manifest.ts:100-101` | `hasBadString` only checks `typeof !== "string"`; empty/whitespace optional `model`/`thinking`/`engine` pass validation (asymmetric with required fields which trim-check). | Add `.trim() === ""` to `hasBadString` (or reject empty). No return-shape change. |
| **D2-4** ✅ | `workflow-pack-manifest.ts:57-61` | `read()` and `JSON.parse()` share one try/catch; a read error (EACCES, EISDIR, injected-read throw) is misreported as "not valid JSON". | Split: catch read separately from parse. Better message only. |
| **D8-1** ✅ | `spawn-subagent.ts:101` | `String(out ?? "")` on a schema-validated object → returns `"[object Object]"` as a success-shaped result (`exitCode:0`). Schema payload destroyed. | `typeof out === "object" ? JSON.stringify(out) : String(out ?? "")`. |
| **D8-2** ✅ | `deep-research.ts:42` | `(plan.queries …)` — `plan` from a schema agent is `null` on recoverable exhaustion → `null.queries` throws opaque TypeError, killing the whole run. | Null-guard `plan` → throw a clear, prefixed error (or degrade explicitly). |
| **D8-3** ✅ | `adversarial-review.ts:43` | Same as D8-2: `investigation.findings` throws when the schema agent returns `null`. | Same null-guard + clear error. |
| **D9-8** ✅ | `workflow-tool.ts:422 vs 478` | The `agentCount === 0` ("must call agent() at least once") guard fires ONLY on the inline `background:false` path; the default background path returns a `runId` without validating → caller trusts a false "started". | Hoist the `agentCount === 0` check before the background/inline fork (parse-time check already exists; reuse it). |

## 2. Confirmed defects — contract change (6) — NEEDS USER CONFIRMATION

These change a return shape or runtime semantics. Per plan §4, do NOT fix without explicit confirmation.

| ID | File:line | What | Contract change | Suggested disposition |
|---|---|---|---|---|
| **D3-1** ✅ | `workflow-pack.ts:238-246` + `workflow-tool.ts:395-404` | `manifest.thinking` is validated + stored + documented ("Default thinking level; overridden by --thinking") but **never applied on either path** — silently dropped. | Applying it (Path A: thread into `runWorkflow`; Path B: needs new `ExecOptions` hook) changes runtime thinking behavior. Alternatively: warn or error on a declared-but-unused field. | Recommend: **pin the current dropped behavior with a guard + warning** now (low-risk), defer full application to an issue. OR apply it if you want it load-bearing. |
| **D6-1** ✅ | `workflow.ts:828-830` | `completenessCheck` returns `agent(...)` bare; on recoverable exhaustion agent() → `null`, so the critic's "verdict" is `null` and a caller doing `c.complete` reads `undefined` (falsy) — a non-answer masquerades as "incomplete". | Changing the failure return (e.g. `{complete:false, missing:[], unavailable:true}` or throw) is a contract change. | Confirm desired shape. |
| **D6-2** ✅ | `workflow.ts:791` | `loopUntilDry`: `(await opts.round(r)) ?? []` coerces a null round to `[]`, counted as a genuine dry round → after `consecutiveEmpty` it exits with NO `.truncated` flag. Recoverable failure presented as "source ran dry". | Surfacing it (a `.roundFailed` flag, or count null-rounds separately from empty rounds) changes the return array's attached fields (like RCA#8 did). | Confirm: add a flag mirroring RCA#8's `.truncated`? |
| **D7-1** ✅ | `run-persistence.ts:192` | Same-runId concurrent saves share `${runId}.json.tmp` → A's rename can promote B's content (A's data lost) or B's rename throws ENOENT. Atomic-write guarantee undermined under concurrent same-run writers. | Per-writer tmp suffix changes the on-disk tmp filename contract (internal, but a behavior change). | Edge case (concurrent same-runId writes are rare). Confirm whether to fix now or defer. |
| **D7-3** ✅ | `run-persistence.ts:286` | `acquireRunLease` treats a lock as live iff `pidIsAlive(existing.pid)`; `startedAt` is recorded but **never aged**. A recycled pid wedges the run permanently (no steal). | Age-based expiry (e.g. `startedAt` older than N → steal) changes lease semantics. | Confirm a max-lease-age or leave as-is + `.todo`. |
| **D7-5/D7-8** ✅ | `run-persistence.ts:190-195` | `.bak` is written AFTER rename with the same JSON just promoted — it's a snapshot of CURRENT state, not "previous good save" as the comment claims. First-save crash leaves no `.bak` at all. | Either fix the comment (low-risk) or reorder writes so `.bak` precedes rename (durability change). | Recommend: fix the misleading comment (low-risk) + pin actual `.bak` semantics; defer reorder. |

## 3. Defect — out of scope / platform (1)

| ID | File:line | What | Disposition |
|---|---|---|---|
| **D7-6** ✅ | `run-persistence.ts:192` | No `fsync` of tmp (before rename) or parent dir (after) → atomic w.r.t. SIGKILL but NOT durable w.r.t. power loss. `FsLayer` exposes no `fsyncSync`/`openSync` so it can't be retrofitted via injection. | Defer. Real but platform-level; retrofitting fsync needs an FsLayer change + careful test design. `.todo` + issue. |

## 4. Coverage gaps (41) — pin current behavior

All verified as real unpinned branches (no source change; guard only). Grouped by dimension. Full per-finding detail in the dimension agents' reports; controller spot-checked representatives from each group.

- **D1 (4):** `.js`-suffix candidate ordering (line 129); not-found error's repo-root branch listing searched paths (168-171); `tryResolvePack` entry-exists-but-is-directory branch (200); `bun-apps`-is-a-file silent-skip (149).
- **D2 (4):** `hasBadString` on `null` (101); required-field wrong-type error wording (74); `args` number/boolean acceptance (90); explicit-`undefined` optional field `in`-semantics (101).
- **D3 (4):** Path A `persistLogs`/`runsDir` ownership vs Path B relying on engine default (workflow-manager.ts:46); Path B bypasses `resolvePackOverrides` (next manifest field will land Path-A-only — the structural cause of the model asymmetry) (395); `dryRun` Path-A-only (321); Path A end-to-end forwarding of resolved model into `runWorkflow` (388).
- **D4 (6):** `--out-dir` > `PI_WORKFLOWS_OUT_DIR` > default precedence (106); missing-`<name>` throw path (97); `workflow list` cwd fallback (169); `--dry-run` CLI-layer plumbing (112); `kindOf` branches incl. throwing-getter catch (191); `--json` purity vs verbose-gated phase logs (116).
- **D5 (5):** `listWorkflows` `.pi`-first + pkg ordering determinism (279); malformed single-file `.js` → `errors` (305); `readdirSyncSafe` → `[]` masking unreadable dirs (78); `findRepoRoot` both-marker precedence (215); non-`.js` skip + `.mjs` doc-vs-behavior gap (304).
- **D6 (3):** `verify()` truthy-but-schema-noncompliant reviewer → silent `real:false` (702-709); `judgePanel` partial-noncompliance → silent 0 in average (745); `gate()` null/undefined validator verdict → silent `ok:false` (858-860).
- **D7 (3):** `generateRunId` source determinism/entropy (318); concurrent-acquisition-after-stale spurious null (289); orphan `.tmp` inertness under load/list (192).
- **D9 (8):** malformed non-string `name` coercion (636); non-object `args` passthrough (645); `background:false` inline return shape (499-516); 5 tuning knobs' plumbing into manager options (423); checkpoint headless `confirm===undefined` fallback semantics (413); `mergeArgs(undefined, undefined)` double-absent (398); unreachable post-normalize throw wording (401); `hasUI` truthiness gating (413).

## Discarded (false positives)
None discarded at the defect level — all 13 defect claims verified true. (Coverage-gap claims were not exhaustively re-verified line-by-line; they will be confirmed during guard implementation — a wrong gap claim simply produces a guard that needs adjustment, no silent risk.)

## Final dispositions (Task 6 scope — user-approved "recommended scope")

**Fix (source edit + guard) — 6:**
- D2-1, D2-4 (manifest validation, `workflow-pack-manifest.ts`)
- D8-1 (`spawn-subagent.ts`), D8-2 (`deep-research.ts`), D8-3 (`adversarial-review.ts`)
- D9-8 (hoist `agentCount===0` guard, `workflow-tool.ts`)

**Pin guards (current correct behavior) — 4:**
- D3-2 + D3-3 (Path A owns persistLogs/runsDir; cross-path args-merge equivalence) — `workflow-tool-pack.test.ts`
- D4-1 (CLI `--out-dir` > `PI_WORKFLOWS_OUT_DIR` > default precedence) — `pi-agent-cli/tests/workflow-command.test.ts`
- D5-1 (`listWorkflows` `.pi`-first + deterministic pkg ordering) — `workflow-pack.test.ts`

**`.todo` pending guards (document correct behavior for latent coercion) — 3:**
- D6-3, D6-4, D6-5 (verify / judgePanel / gate null→default; currently unreachable in production via schema enforcement but latent in engine logic) — `regression-rca.test.ts`

**Deferred → backlog issue (contract change / OOS) — 7:** D3-1, D6-1, D6-2, D7-1, D7-3, D7-5, D7-6 → tracked in `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md` and one consolidated GitHub issue.

**Remaining coverage gaps (37):** not pinned this pass; recorded here as the residual backlog for a future pass.

## Summary (pass complete — 2026-07-18)

**Branch result:** 13 commits, all tasks reviewed clean. Final whole-branch review (opus): **Ready to merge**, 0 Critical / 0 Important, 3 non-blocking Minors. CI gate (`pi-agent-ext-workflow`: `bun run build && bun test`; `pi-agent-cli`: `bun test`) is green on the branch (one known flaky `usage-limit-integration.test.ts` timeout under parallel load passes in isolation; pi-agent-cli's pre-existing e2e timeouts are unrelated). biome `check` formatting drift is pre-existing and intentionally excluded from this package's CI gate (see `.github/workflows/ci.yml`).

**Fixed + guarded (6):** D2-1 (empty/whitespace optional manifest fields — repo-wide grep confirms no in-repo pack is affected), D2-4 (read vs JSON error split), D8-1 (spawn-subagent schema → JSON.stringify), D8-2/D8-3 (builtin workflow null-guards with clear errors), D9-8 (no-agent workflow rejected on background path too).
**Pinned guards (4):** D3-2 (Path B omits persistLogs/runsDir/outDir), D5-1 (listWorkflows `.pi`-first), D4-1 (CLI `--out-dir` > env > default), plus the Task 2/3 guards (Path B model asymmetry, findRepoRoot cap).
**`.todo` RCA targets (3):** D6-3/4/5 (latent verify/judgePanel/gate null→default coercions).
**Deferred → issue #630 (7):** D3-1 (manifest.thinking dropped), D6-1 (completenessCheck null), D6-2 (loopUntilDry null-round), D7-1 (concurrent tmp race), D7-3 (pid-recycle lease wedge), D7-5 (`.bak` semantics), D7-6 (no fsync).
**Residual (37 coverage gaps):** recorded in §4 for a future pass.
