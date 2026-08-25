---
effort: 2026-08-25-s2-agent-simplify-round2
created: 2026-08-25
last: 2026-08-25
status: charted
---

# s2-agent simplify ROUND 2 — structure / docs+scripts / duplicate tests / ultracode necessity

## Destination

`bun-apps/s2-agent` carries no same-seam duplication round 1 left behind (env-flag parsing, repo-root walks, agent-dir hand-rolls, git/spawn boilerplate, truncation helpers), its test suite has no assertion that another test already makes at the same seam, its docs/scripts dir holds zero dead files, and the ultracode/workflow question is answered with usage receipts recorded here. Phase D extension (2026-08-25): the launcher run.sh carries one doc surface not two and no dead flag, the package's md cites only files that exist, and no tracked runtime receipts sit in `output/`. Same bar as round 1: every ticket merges through package gates + independent reviewer + local_ci ≤ 5 min; the 0.7.10→0.7.11 version bump rides the first PR.

## Context

Measured 2026-08-25 on this machine (branch off origin/main @ 2e876407; four read-only explore agents over the package). Round 1 (`.planning/2026-08-24-s2-agent-simplify/`, #1992–#2002) already consolidated settings reads / agent-dir / transcript discovery / printTable / rest-parsed flags / session-tail / patches boilerplate — everything below is what REMAINS after it.

### Structure (89 non-test .ts / 16,120 LOC; 79 test files / 11,767 LOC)

- Top files: registry-config 693 (~433 LOC = 26-entry data table, NOT a smell), pre-load-providers 625 (~275 LOC provider literals, side-effect-free by design), cli/args 601, cli/dispatch 585, cli/sessions/shared 580, doctor 567, pdf-to-vault 550.
- Remaining duplication clusters (all verified file:line 2026-08-25):
  - **envFlag ×3** — canonical `src/patches/index.ts:151-158`; hand-rolls at `cli/sessions/shared.ts:246-249`, `__tests__/e2e-harness.ts:21` (harness can't import patches; shared.ts can host a leaf).
  - **repo-root walk bypassing `findRepoRoot` ×4** — `run-dir/check-deps.ts:46`, `patches/ensure-extension-deps.ts:73`, `run-dir/run-context.ts:38`, `ext-doctor.ts:32` (PI_AGENT_DIR-based, possibly deliberate — verify). `cli/commands/schema-cost.ts:206-211` wraps the seam correctly.
  - **agent-dir hand-roll** — `cli/commands/agent-trends.ts:91,167` builds `~/.pi/agent` itself, silently ignoring `PI_CODING_AGENT_DIR` (round-1 D5 bug class).
  - **git-spawn boilerplate ×2 + 12 unshared spawn sites** — `pipeline-gate.ts:200-215` ≡ `agent-trends.ts:114-125`; ad-hoc wrappers in loop.ts:104, ext-new.ts:355/426, doctor.ts:385, deps-probe.ts:171.
  - **findExistingRun twins** — `pdf-to-vault.ts:147-158` / `memory-to-vault.ts:97-104` (same skeleton, different policy — parameterize, don't merge blindly).
  - **truncation ×3 + humanizers ×3** — dispatch.ts:299 `clip`, task-runner.ts:65 `trunc`, format.ts has no shared clip; humanizeTokens dispatch.ts:235, tools-metrics.ts:209/214.
  - **`json ? JSON.stringify : "…"` ternary ×8** — pattern duplication, shapes differ (memory-to-vault.ts:194, knowledge-pipeline.ts:243, workflow.ts:198, doctor.ts:363, agent-trends.ts:209, zk-query.ts:98/125/170, ext-doctor.ts:236); shared `emit()` only if shapes converge honestly.
  - **hand-rolled table rows** — workflow.ts:208, agent-trends.ts:65 bypass printTable.
- God-interface: `cli/args.ts:59-160+` `ParsedArgs` carries fields for ~15 commands; `cli/dispatch.ts` ≥4 responsibilities (registry, 90-line root-help literal, model/tool listing, argv state machine); `cli/sessions/shared.ts` ≥5. External pins (round-1 census) still forbid mass file moves — logic consolidation only.
- `details: "Usage:"` hand-written help ×21-23 files duplicating flag-spec.ts prose (e.g. `--vault` documented 5×) — this is the defineCommand-help-regen follow-up (round-1 D2), NOT re-litigated here.

### Tests (79 files / 11,767 LOC ≈ 73% of src; ~1,833 cases)

- **Same-seam duplication, delete-with-equivalence-proof candidates (~330-400 LOC, all low/very-low risk):**
  1. `src/static-extensions.test.ts` (40 LOC, whole file) — both asserts verbatim at `run-dir/manifest-consistency.test.ts:59,76`.
  2. `src/__tests__/cli-argv.test.ts` — strict subset of `src/cli-argv.test.ts:74-140` except its `webuiFlags` describe (14-58); merge that in, delete the file.
  3. "extension exists on disk" ×3 — `run-dir/registry.test.ts:24-29` ≡ `registry-config.test.ts:175` ≡ `manifest-consistency.test.ts:99-113`; registry-freshness proves manifest ≡ registry output, so keep only registry-config (pre-generation). registry.test.ts's unique bits are weak-value (toBeBoolean shape checks; `proj/` checkout-dir pin at :34).
  4. `parseWorkflowArgs` ×2 — `workflow.test.ts:19-38` ≡ `workflow-command.test.ts:118-130` case-for-case.
  5. Root-help e2e ×2 — `e2e/meta.e2e.test.ts:29-43` ≡ `e2e/help-dispatch.e2e.test.ts:67-80` (same runCli harness); keep meta's `[]`+version rows.
  6. `detectMode` ×2 — `mode.test.ts:9-18` ≡ `run-dir/resolve.test.ts:18-35`; mode.test.ts:23-40 is self-duplicating/tautological on top.
  7. Weakest-value singles ~25 LOC: host-modules.test.ts:5-7 (asserts 1===1), memory-to-vault-script.test.ts:29-31 (`toContain("25")` re-echo), extensions-registry.test.ts:55-59 (echo), registry outRoot pin.
- **Harness duplication (~150-250 LOC):** 8 private spawn harnesses (e2e/_helpers.ts runCli is the only shared one; boot-smoke.test.ts:40 admits "mirrors runCanary pattern"; cli-sh-main-argv.test.ts:56-103 is 48 LOC); 17 files with hand-rolled mkdtemp/tmpdir boilerplate; makeMockPi ×3 in-package variants (extension-contract, tool-name-contract, extension-shortcut-guard).
- No whole-file duplicate among the >300-LOC tier (args, tools-metrics, force-response-language, ext-loader are genuinely distinct seams). The 73% ratio overstates coverage density; the real cost is harness duplication, not behavior tests.

### Docs + scripts

- **DEAD:** `baselines/schema-cost-baseline.json` (zero readers; the LIVE baseline is repo-root `scripts/schema-cost-baseline.json`, consumed by ext-devops schema-cost-check.ts:85 — the package copy is a pre-rename stale snapshot, they differ). package.json scripts `cli`, `list` (zero invocations repo-wide), `test:e2e` (superseded — ext-devops run-test.ts sets PI_AGENT_E2E itself).
- **STALE:** ADR 0005 (zero citations — verify content then delete or re-cite); `workflows/lib/lexical-overlap-check.mjs` + its test (393 LOC, no consumer — knowledge-distill.js does not import it); dead citation to nonexistent `workflow-retrieval-quality.test.ts` (from `src/cli/__tests__/workflow.test.ts:14`). CORRECTED at execution 2026-08-25: `src/cli/__tests__/__fixtures__/` is NOT empty — it holds the LIVE `boot-smoke.baseline.json` (read by boot-smoke.test.ts:20); the "empty dir" claim from the chart agent was wrong and is NOT deleted.
- **KEEP (all of it is deliberate):** 5 shell runners = opt-in manual-tier ladder (L1 offline CI → L2/L3 manual), each with test/doc tether; regen-manifest/regen-static/scrub preload are load-bearing; run.sh is the front door. No script duplicates devops-ext functionality.

### ultracode/workflow necessity (user question 2026-08-25: "is s2-agent/workflow still necessary????")

Measured from `~/.pi/agent/sessions/**.jsonl` (4,737 session files, 2026-06-27→08-25, counted toolCall records not mentions):

- **Maintenance surface:** engine `s2-agent-ext-ultracode` 11,176 src LOC (workflow-* = 6,796; riders cron/wakeup/loop/effort/deep-research/model-routing/web-tools ≈ 4,400) + **21,080 test LOC** (~45 files riding the CI matrix row) + s2-agent-side integration ~1.1k (cli/commands/workflow.ts 228 + its 418 LOC tests + ~440 LOC sample packs) + registry/static-extensions/manifest/schema-cost-baseline wiring + ci-matrix ordering note.
- **Usage receipts:** workflow + run_workflow = **155 calls all-time**, heavy 06-27→07-05 (up to 17/day), tapering July, **near-zero 08-07→08-20 (1-4/day), 0 on 08-25**; the 74-call spike on 08-21 was the schema-cost dev effort itself. `/workflows` 254 hits, same decay curve. cron tools **0 invocations ever**; schedule_wakeup 4; wf_web_search/fetch 0. movie tool 2,179 calls but ALL 07-05→07-19, zero in 5+ weeks. Persisted run logs ~99% test artifacts (resume-probe 3,538 of 5,894). Only ~2.2% of sessions (106/4,737) ever touched a workflow-family tool.
- **Riders are alive:** /loop 19 uses, CLAUDE.md's drift report (`./s2-agent.sh cli loop status`) rides the loop machinery; #1990/#1995 (2026-08-24) maintained loop/wakeup — zero-usage cron is the clear trim inside the package.
- **Hard dependents (block REMOVE):** ext-movie-director (`movie-manager.ts:17-18` imports WorkflowManager + createWebTools; runs 4 saved packs, ~472 LOC, registry-enabled deploy ext), s2-agent `cli workflow run/list`, ext-flux2 `self-improve-loop.driver.ts:23`, ext-tool-gate references. NOT dependents: subagent, devops (doc note only), wayfind, knowledge-card, obsidian.
- **Available mechanics:** full off = `enabled:false`+disableReason (hyperframes e97cf6c8); deploy-only = `excludeReason` (sv-analyzer/webui); demote = `load:"dynamic"` (webui 2026-08-25) — drops static-bundle + default-session schema-cost while keeping source-mode `-e` loading. Full REMOVE additionally breaks movie-director/tool-gate typecheck until decoupled.

### Round-2 extension (Phase D) — charted 2026-08-25, second session (four read/design agents, all file:line verified)

- run.sh 206 LOC: `--update-help` heredoc (:80-105) ≈ header UPGRADING block (:26-47) — one doc surface duplicated; `update-pi.sh -h` already prints the wrapper docs (:2-48). Link-farm reclaim logic pinned by 5 e2e tests (e2e-launcher.test.ts:208-303) — comments compress, logic stays.
- Dual doctor (src/doctor.ts 567 vs cli/commands/doctor.ts 369): overlap THIN — the result contract is ALREADY shared (cli/commands/doctor.ts:32-39 imports CheckStatus/CheckResult/isFailing from src/doctor.ts); check surfaces deliberately disjoint (deploy/patch health vs fresh-machine portability); renderers differ by channel. → D7, no edit.
- Stale refs: all 8 ADR headers + README:84 cite nonexistent `bun-apps/docs/adr/INDEX.md`; README Layout tree predates #1975 run-dir move; README:63 documents `cli doctor [--smoke]` (wrong — `--smoke` is the root doctor's); knowledge-distill.js:25 cites nonexistent `../docs/workflow-cli.md`.
- `output/kcard-extract/` holds 2 tracked runtime receipts (13 LOC each; writer ext-knowledge-card src/extract.ts:489,691 declares the dir gitignored per its D30; `.gitignore:126 output/` matches — tracked-ness bypassed it).
- dispatch-log.ts: no workflow *code* branch — dead surface is the `"workflow"` engine-union half (producer died in ticket 02), `--effort`/`--tier` filters (manual records always `effort/tier:"unknown"` ⇒ permanently unmatched), NOT-YET-WIRED prose. Command LIVE (taught in dispatching-parallel-agents SKILL.md:98).
- completions inline-in-dispatch: load-bearing (circular-import hang, completions.ts:11-15 / dispatch.ts:434-435); META vs META_COMMANDS deliberately differ (dispatch.ts:112 vs completions.ts:36); `e2e/meta.e2e.test.ts` pins output. → D8, no edit.

## Tickets

**Execution order:** 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 — **user-confirmed 2026-08-25** (01 first is no-choice — the version bump rides it; 03 before 04 so deletions land before helpers consolidate what remains; user declined swapping tests-track (03-04) ahead of structure-track (05-06); Phase D extension 08–10 confirmed in a second 2026-08-25 session — full sweep, `--update-help` drop approved, md depth = README slim + stale refs, vehicle = extend this map; 11 split out of ticket 06 at execution per the Fog clause)

### Phase A — sweep & disposition

- [x] 01 — Dead surface + scripts/docs purge + **version bump 0.7.10→0.7.11** (complete 2026-08-25, PR #2014 squash 3d1ac80d: baselines + lexical-overlap (393 LOC) + scripts cli/list/test:e2e + dead citation deleted; ADR 0005 verdict = RE-CITED at pre-load-providers.ts header; `__fixtures__/` NOT empty — claim corrected, fixture kept; version 0.7.11 lockstep; reviewer READY, local_ci pass, merged via devops chain)
- [x] 02 — ultracode disposition (B) TRIM executed (complete 2026-08-25, PR #2015 squash d5fc9578: census FIRST — packs + knowledge-distill + ADR 0003 STAY (ext-ultracode hard test deps), only CLI surface removed (workflow.ts 228 + suites 418 + dispatch namespace + completions + flag rows + ParsedArgs fields); engine byte-untouched, 3 dependents typecheck green; reviewer NOT-READY→fixed 2 doc blockers→merged; engine-side Path-A doc debt in Fog of war)

### Phase B — tests

- [x] 03 — Same-seam test dedup (complete 2026-08-25, PR #2018 squash 9859324d: 7 candidates, per-deletion equivalence proofs in ticket Outcome; 11 files +82/−248; 1021→969 tests 0 fail; reviewer READY 0 blockers 4 NITs recorded; effort=full e2e green)
- [x] 04 — Shared test-utils (complete 2026-08-25, PR #2019 squash e00e8d7a: src/__tests__/test-utils.ts — makeMockPi union recorder / spawnCaptureSync+Async / tempDir+cleanupTempDirs; numstat honestly −208 dedup / +163 helper / +40 all-in; fixed a dead dirs[] tmp-leak; 15 try/finally tmpdir files deliberately unchanged; reviewer READY after 2 receipt NITs fixed)

### Phase C — structure

- [x] 05 — Seams A: envFlag leaf, findRepoRoot migration ×4 (ext-doctor PI_AGENT_DIR case verified first), agent-trends → resolveAgentDir, shared git-spawn helper; no file moves (external pins) (complete 2026-08-25, PR #2029 squash 1bf08c43: envFlag ×4→leaf src/env-flag.ts — chart census said ×3, reviewer found the 4th (e2e-image-agent) and it rode the same PR; findRepoRoot ×4 marker-walk; agent-trends honors PI_CODING_AGENT_DIR (flagged delta); gitLines leaf src/cli/git.ts null-vs-empty contract; version 0.7.14; reviewer With-fixes→applied; local_ci 213s pass; merged via Linux-box policy)
- [ ] 06 — Seams B: clip/trunc + humanizer consolidation into format.ts, findExistingRun parameterize, printTable adoption at workflow.ts:208 + agent-trends.ts:65; `emit()` helper only where shapes honestly converge; lazy-extensions dead-path fold-in if the registry zero-import contract survives contact — measured outcome: clip ×2 unified; humanizers/findExistingRun/printTable/emit() all SKIP-with-measurement (genuine difference, not duplication); lazy-extensions SPLIT → 11; gitLines contract test added (complete 2026-08-25, PR #2031 squash 09408c53: reviewer With-fixes→applied — byte-identity verified against pre-images, skip receipts spot-verified, criterion-integrity fixes; local_ci green except the documented macOS-only sandbox-exec gate; version 0.7.15)
- [ ] 07 — SDK-contract guard test (carried from t06): source-scan the pinned pi-coding-agent dist for setExtensionStatus→requestRender so a pi bump can't silently drop footer rendering (complete 2026-08-25, PR #2032 squash f33ca4d8: call-SHAPE matcher /requestRender\s*\(/ — the reviewer-demonstrated substring hole (symbol-EXTENDING rename) closed; genuine 4-variant deliberate-red receipts; window-tightness assert; Bun createRequire package.json-subpath resolution with rationale; version 0.7.16)

### Phase D — round-2 extension (user-confirmed 2026-08-25: full sweep)

- [ ] 08 — Launcher slim: run.sh 206 → ~150-160 LOC — delete `--update-help` (heredoc duplicates header UPGRADING block; upgrade docs single-source in `update-pi.sh -h`; behavior delta flagged in PR) + its paired e2e describe + run-test.ts comment; compress header/comments ONLY, logic verbatim (link-farm reclaim tests pin it; KEEP the regular-file reclaim-safety rationale) (complete 2026-08-25, PR #2033 squash e6376161: 206→132 LOC; reviewer's comment-stripped diff = the equivalence-proof method — caught the undisclosed dead pre-init ENTRY=""/MODE="" removal (set -u-safe, kept deleted, recorded); reclaim invariant preserved; 12/12 launcher e2e; version 0.7.17)
- [ ] 09 — md cleanup: 8 × ADR line-1 `Index: bun-apps/docs/adr/INDEX.md` (nonexistent) → repo-root `CONTEXT-MAP.md`; README stale Layout tree → ~6-line map to code headers + `:63` doctor-command fix; knowledge-distill.js:25 stale doc ref. No bump (no shipped surface)
- [ ] 10 — misc: `git rm` the 2 tracked `output/kcard-extract/*.json` runtime receipts (zero readers; `.gitignore:126` already matches); dispatch-log trim (drop `"workflow"` engine half + `--effort`/`--tier` dead paths + NOT-YET-WIRED prose; command stays live); completions split deferred by D8
- [ ] 11 — lazy-extensions dead-path removal (split out of 06): resolver + registry exports + derived manifest + generated static-extensions header + ext-doctor reader + 3 test files; D5 equivalence proofs; regen receipts

## Decisions

- **D1 — Round-1 REJECTED merges stay rejected** (printModel, gating unify, ensure-model-tiers — round-1 map D-entries with evidence). Not re-litigated.
- **D2 — registry-config.ts and pre-load-providers.ts largeness is DATA, not smell** (~433 + ~275 LOC literals respectively; zero-import and side-effect-free constraints documented in-file). No split tickets.
- **D3 — defineCommand help regeneration (~1,900 LOC) and makeMockPi cross-package dedup stay OUT of this effort** (round-1 D2/D3 unchanged) — they remain ranked follow-ups, not tickets.
- **D4 — ultracode verdict: (B) TRIM s2-agent-side surface — USER-CONFIRMED 2026-08-25.** The engine package and its riders stay enabled and untouched; s2-agent's own workflow surface (cli/commands/workflow.ts + its 418 LOC tests + sample packs) is removed, engine stays importable for movie-director/flux2/tool-gate; cron zero-usage + usage-decay receipts land in CONTEXT.md for a future engine-side effort. Rejected: (A) keep-as-is (21k test LOC + CI row riding for ~0 organic use since Aug 7), (C) `load:"dynamic"` demotion (kills default availability of live riders /loop, wakeup, effort, deep-research — recent maintenance #1990/#1995), full REMOVE (hard dependents: movie-director movie-manager.ts:17-18, flux2 driver, tool-gate typecheck). Ticket 02 encodes the trim.
- **D5 — deletion-with-equivalence-proof per candidate, never bulk** (same rule as round 1): each test deletion quotes the surviving assertion that covers the same seam.
- **D6 — no file moves** (round-1 external-pin census unchanged: cli.ts, cli-sh.ts, patches/*, static-extensions.ts, run-dir/{manifest.json,check-deps.ts}, sh/*, pre-load-providers.ts, run-dir/registry.ts are pinned by devops/deploy/run.sh/ext consumers).
- **D7 — dual doctor stays two files** (verified 2026-08-25): the shared result contract already lives once (cli/commands/doctor.ts imports it from src/doctor.ts:32-39); check surfaces are disjoint by design; renderers differ by channel (colored stdout vs stderr checklist). Consolidation would change output bytes both test suites observe for ~zero dedup. Forced merges rejected on evidence.
- **D8 — completions inline-in-dispatch split stays** (verified 2026-08-25): the split is a load-bearing circular-import workaround; `META` (dispatch.ts:112) vs `META_COMMANDS` (completions.ts:36) differ deliberately; `e2e/meta.e2e.test.ts` pins the output bytes. "Fixing" the awkwardness changes completion output.
- **D9 — `--update-help` removed; upgrade docs single-source in `update-pi.sh -h`** (user-approved 2026-08-25): the run.sh heredoc duplicated the header's UPGRADING block — one doc surface, one source. Replacement path: `./s2-agent.sh --upgrade --help` reaches the wrapper's docs. The paired e2e describe is deleted WITH the flag (consistent pair).

## Frontier

Ticket 05 — no blocker; every seam is file:line-verified in Context, the ext-doctor PI_AGENT_DIR verify-first gate is written into the ticket, and patches/run-dir being DEPLOY_SENSITIVE means the launcher e2e runs explicitly. Then 06 → 07 → 08 → 09 → 10 in order (08 before 09 so the README "map to code headers" describes the final launcher; 10 last — it touches a cross-package skill doc and benefits from the settled tree).

## Fog of war

- **Engine-side live docs still cite the removed "Path A" CLI** (ext-ultracode CONTEXT.md:32, PRD.md:26,62,98, workflow-pack.ts:6 header) — reviewer finding on ticket 02; the engine package is deliberately out of this effort's scope, so a future engine-side effort must own the doc fix (CONTEXT.md Path-A sentence is factually wrong as of 2026-08-25). NOTE (ticket 09 review): `bun-apps/s2-agent/workflows/knowledge-distill.js:27-32`'s stale `cli workflow run` INVOCATION block lives in the S2-AGENT package — if the engine-side effort scopes itself "engine package only," this file falls between chairs; whichever effort opens first takes it.
- **Repo-wide stale `Index: bun-apps/docs/adr/INDEX.md` backlog = 35 md files** across ext-ultracode/core-runtime/hermes-memory/wayfind etc. (reviewer-measured 2026-08-25, ticket 09) — s2-agent's 8 are fixed; the sweep owns the rest.
- ext-doctor.ts:32 repo-root copy uses `PI_AGENT_DIR` (not PI_CODING_AGENT_DIR) — deliberate or drift is UNMEASURED; ticket 05 verifies before migrating. **RESOLVED 2026-08-25 ticket 05: legacy package-dir NAME, not drift — kept (verdict comment at the const; see ticket 05 Outcome).**
- movie-director `/movie` runs may journal outside `~/.pi/workflows/projects` (no produce-video/review-cut run logs found despite 2,179 movie tool calls) — UNVERIFIED; only matters if option C or REMOVE is ever revisited.
- Ultracode's exact schema-token share inside the 83-tool/25,641-token aggregate baseline is UNMEASURED (baseline is aggregate); measurable if option C is chosen.
- `--no-session` parsed global with zero readers (round-1 fog, still open) — candidate for the next flag audit, not ticketed here.
- lazy-extensions dead-path removal may exceed ticket 06's budget if the manifest-types surface is wider than expected — split rather than cram.
- **Other packages' ADR headers carry the same stale `Index: bun-apps/docs/adr/INDEX.md` line repo-wide** (found charting Phase D, 2026-08-25) — out of this effort's scope (s2-agent only); a repo-wide doc-hygiene sweep would own it.

## Cross-effort links

- `Builds-on: 2026-08-24-s2-agent-simplify` — every seam named in Context is the residue that effort verified as remaining; its REJECTED list is our D1/D3.
- `Shares-decision-with: 2026-08-25-archify-webui-decouple` — the `load:"dynamic"` demote mechanic (its D1) is option C's implementation path; webui's frozen-contract discipline applies to any ultracode surface trim that touches `/workflows resume` interop.
- `Absorbs: s2-agent version bump carry` (Honest-gaps item from next-goal-20260825-022920) — 0.7.10→0.7.11 rides ticket 01.
- `Complements: 2026-08-25-ultracode-cc-parity` — the engine-side effort D4's "future engine-side effort" clause named; it upgrades ext-ultracode's armed guidance to claude-code ultracode behavior while our ticket 02 trims s2-agent's OWN cli surface (orthogonal files, no seam overlap).
