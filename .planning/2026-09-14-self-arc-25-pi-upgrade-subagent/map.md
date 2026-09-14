---
effort: 2026-09-14-self-arc-25-pi-upgrade-subagent
created: 2026-09-14
last: 2026-09-14 (closed)
status: done
---

# Wayfinder map: 2026-09-14-self-arc-25-pi-upgrade-subagent — pi 0.84.4 → 0.85.1 + subagent upstream-parity

Planned 2026-09-14 in THIS worktree (`video_generation__subagent`, branch
`self-arc-25-pi-upgrade-subagent` at `6c3c400f`, verified cut). Ledger number 25
claimed in `.planning/arc-ledger.json` (status active, this branch). Research
evidence committed: `evidence/local-tarball-diff.md` (npm-dist symbol diff —
authoritative), `evidence/cc-ext-sources-digest.md` (upstream 80+ first-party
extension study), `evidence/sdk-changes-digest.md` (SDK risk list). Every file:line
below was read by the planner on 2026-09-14 unless attributed to those digests.

## Destination

The repo runs on pi 0.85.1 with every gate green, and `s2-agent-ext-subagent`
takes the upstream patterns that are worth taking — each delta falsifiable on a
DEPLOYED tree in an isolated work env:

1. **Upgrade landed (t01).** All `@earendil-works/pi-*` pins at 0.85.1 across the
   29 `bun-apps/*` package.json files (deps + peerDeps), lockfile recomputed
   (chord in, pi-client/pi-protocol out), zero removed-import breakage (evidence:
   REMOVED-and-USED = ∅), `zai/glm-5.3` resolution + a live GLM-5.3 headless
   smoke green in the SOURCE tree.
2. **Child-output economics (t02).** The parent LLM sees at most ~50KB per child
   output (singular `subagent` content AND per-slot `list_subagents` bodies —
   both measured unbounded today); the full text survives in tool `details`
   (UI expand) and the durable run record (already persisted) with a
   grep-able "full output preserved" marker.
3. **cwd delegated to pi (t03).** 0.85.0's per-call `ctx.cwd` fix is VERIFIED on
   our embedded child-session path (child cwd ≠ parent cwd resolves read/bash
   correctly), and the `createCodingTools(runCwd)` re-binding workaround at
   `core-runtime/src/agent.ts:361` is removed — or the ticket exits as a
   documented no-op with committed probe evidence (arc-24 t04 pattern).
4. **Project-agent trust gate (t04).** Project-local `.pi/agents/*.md`
   definitions (`source === "project"`) in an UNTRUSTED project require an
   explicit gate before they bind a child: `ctx.ui.confirm` when hasUI,
   default-DENY with a clear error naming the file when not (upstream
   `subagent/index.ts` parity; our registry loads them freely today).
5. **Usage-ledger adjudication (t05).** Per-message usage aggregation is landed
   ONLY if it costs one seam (the budget layer already observes per-API-response
   usage); otherwise a dated REJECT with anchors is committed — never a vacuous
   "done".
6. **Deployed verification (t06).** The upgraded tree deployed to a PINNED
   immutable version dir, bundles grep-asserted for the pi 0.85.1 version string
   AND the new load-bearing symbols BEFORE driving; isolated scratch-repo work
   env; GLM-5.3-only model proofs; receipts committed under `evidence/`.
7. **Close-out (t07).** Shipped-as with merged PRs, statuses flipped in the same
   PR, ledger `mergedPr`, reciprocal back-links, successor next-goal (strict v2).

## Context

Measured 2026-09-14 in this worktree (branch `self-arc-25-pi-upgrade-subagent` at
`6c3c400f`), read by the planner (grep/read, not assertion), except where
attributed to the committed evidence digests:

- **Upgrade surface**: `0.84.4` pinned EXACT (no `^`) in **29** `bun-apps/*`
  package.json files (measured `grep -rl '"@earendil-works/pi-' --include=package.json
  | grep -v node_modules | wc -l` = 29; e.g. `bun-apps/s2-agent/package.json:25-28`
  all four packages, `s2-agent-core-runtime/package.json:32-40` deps+peers,
  `s2-agent-ext-subagent/package.json:59-67`). One scoped sed per file + one
  `bun install` from `bun-apps/` covers it.
- **Import surface is root-only**: no `@earendil-works/pi-coding-agent/client`,
  `/experimental/*`, `pi-client`, or `pi-protocol` imports anywhere in repo
  source (grep this session) — the 0.85.1 source-only-subpath removal cannot
  break us (evidence/local-tarball-diff.md: REMOVED-and-USED = ∅ over our ~103
  imported symbols; pi-agent-core churn touches only our `AgentToolResult` +
  `ThinkingLevel`, both present).
- **Risk-list adjudications already measurable**:
  - write-tool byte-count removal: no test in `s2-agent-ext-subagent/tests/` or
    `s2-agent-core-runtime/tests/` asserts the byte-count text (grep this
    session); t01 still sweeps repo-wide (movie-director/archify "wrote" hits
    are TTS/artifact tests, unrelated).
  - pi-tui env-default removals / `PI_DEBUG_REDRAW` rename / `scrollbarThumb`
    ThemeBg→ThemeColor move: zero repo references (grep this session) — N/A.
  - prompt-cache `ttl` field rename: no `supportsExplicitPromptCacheMode` /
    `prompt_cache*` anywhere in bun-apps source or `~/.pi/agent/models*.json`
    (grep this session) — N/A for our zai (openai-completions) config.
  - `setModel`/`setThinkingLevel` session-scoping: our only real call site is
    `presets.ts:11` whose header documents "TRANSIENT BY CONTRACT … switches the
    CURRENT session only" — 0.85 semantics MATCH the documented contract; other
    call sites are test mocks (`s2-agent/src/patches/ext-api-bridge-tripwire.test.ts:60-62`,
    `s2-agent/src/__tests__/test-utils.ts:72`).
- **zai registry churn de-risked by measurement**: pi-ai's
  `dist/providers/data/zai.json` is BYTE-IDENTICAL between 0.84.4 and 0.85.1
  (measured this session from the research tarballs `/tmp/dl-pi-ai-{0.84.4,0.85.1}`:
  same 7 glm ids on the same coding baseUrl). Our extension-provider
  registration (`s2-agent/src/pre-load-providers.ts:439-470`) REPLACES the zai
  model list with a curated re-list anyway — so the changelog's "ZAI China
  models added" does not touch the surface `zai/glm-5.3` resolves through. A
  `--list-models` + headless smoke stays in t01 as the proof, not a port.
- **Output path is unbounded (t02's gap is real)**: singular tool returns the
  full child text to the parent LLM — `subagent-tool.ts:733`
  `return { content: [{ type: "text", text: output }] }` — and the batch embeds
  full per-slot output — `subagents-tool.ts` `renderBatchResult`
  `### [i] … \n${slot.output}`. No cap exists on the LLM-visible path (only
  SALVAGE_MAX_* caps on salvage fields, `subagent-tool-run.ts:195-196`).
  Upstream parity target: `examples/extensions/subagent/index.ts` caps
  per-task output at `PER_TASK_OUTPUT_CAP = 50 * 1024` for the parent, full
  text in tool `details` (evidence/cc-ext-sources-digest.md §2.1). Durable
  records ALREADY persist full output (`persistence.save({ output })` in both
  tools), so the cap is context economics, not retention.
- **cwd workaround exists and is now possibly redundant (t03)**:
  `core-runtime/src/agent.ts:358-361` re-constructs coding tools per run because
  "tools capture their cwd at construction and can't be relocated" (0.84.4
  truth); 0.85.0 fixed bash/edit/find/grep/ls/read/write to honor per-call
  `ctx?.cwd || cwd` (evidence/sdk-changes-digest.md §3.1 — all seven tool files
  verified `ctx?.cwd` absent in 0.84.4, present in 0.85.1). The child session is
  created with `cwd: runCwd` (`agent.ts:444`), so IF the tool-execution ctx
  carries the session cwd in our embedded `createAgentSession` path, the
  re-binding at :361 is dead weight. Probe first; worktree isolation
  (`spawnCwd` ≠ `runCwd`, `subagent-tool.ts:284-290`) is a DIFFERENT concern
  (git-tree isolation, not path resolution) and stays.
- **Trust gate gap is real (t04)**: `agent-registry.ts:137-141` `loadAgentRegistry`
  scans project `.pi/agents` FIRST (precedence project > pack > user > builtin)
  with no trust check anywhere in ext-subagent (grep this session). Upstream
  gates project-local agents behind `ctx.ui.confirm` when
  `!ctx.isProjectTrusted()`, and names the hasUI=false policy explicitly
  (evidence/cc-ext-sources-digest.md §2.1 + §3 gap-2). Both primitives exist in
  the 0.84.4 d.ts ALREADY (`dist/core/extensions/types.d.ts:234`
  `isProjectTrusted()`, `:72` `ui.confirm`) — measured this session. Our
  timeout-default-DENY plan-approval (`request-plan-approval-tool.ts` header)
  is the architectural precedent for the no-UI branch.
- **Usage granularity (t05)**: `onUsage` fires ONCE at completion
  (`spawn-subagent.ts:143-147` "Called once with this subagent's real usage");
  the budget layer already observes usage per API response ("per API response,
  the same getSessionStats() source the onUsage callback reads",
  `agent-budget.ts:103-106`). Upstream's per-message ledger (turns,
  cacheRead/cacheWrite live accumulation, evidence digest §2.1) is therefore a
  PLUMB of an existing observation, not a rebuild — cost decides land-vs-reject.
- **Already at upstream parity — do NOT re-plan**: SIGTERM→5s→SIGKILL ladder
  (`spawn-subagent-subprocess.ts` `killChild`, KILL_GRACE_MS = 5000);
  `SessionManager.inMemory()` in use (`agent.ts:446`, currently no-args — the
  0.85.1 `entries` restore param is opt-in); steer/followUp delivery (arc-23,
  `#2264`/`#2269`); child→parent plan approval (timeout-default-DENY);
  `--mode json -p --no-session` + `--append-system-prompt` temp-file pattern
  (`spawn-subagent-subprocess.ts` `buildSubagentArgs`) — byte-for-byte the
  upstream subagent invocation shape.
- **Deploy trust machinery (learning #1, 2026-09-06)**: `computeCoreHash`
  (`s2-agent-ext-devops/src/deploy/lib/core-cache.ts:11,:48`) hashes the pi
  version AND `workspaceSrcDirs` — a pi upgrade forces a core cache MISS by
  construction; t01/t02/t03 touch core-runtime (inlined into every bundle), so
  t06's deploy expects a FULL rebuild and must verify the cache treated it as a
  miss. `@repo/*` link-farm self-heal shipped in `#2264` (arc-23 t01).
- **Gates**: `s2-agent-ext-subagent` canonical `bun run test` = `check` (biome;
  warnings ≠ failures) + `build` (tsc) + `test:unit`; `s2-agent-core-runtime` =
  `check`/`typecheck`/`test`; `local_ci` resolves gates by script NAME per
  package. Devops CLIs own git phases; version-bump applies when
  `bun-apps/s2-agent/**` changes (t01 edits its package.json pins).
- **Concurrent actors**: `../video_generation__memory` and `../video_generation__movie`
  are off-limits loop worktrees. This arc runs in the caller worktree on the
  claimed branch.

## Scope

IN: t01 (upgrade), t02 (output cap + details preserve), t03 (ctx.cwd
verify-then-simplify with no-op exit), t04 (project-agent trust gate), t05
(usage-ledger adjudication, land-or-dated-reject), t06 (deployed verification
leg, receipts to `evidence/`), t07 (close-out).

OUT (with reasons): client/experimental subpath migration (we import root-only —
measured); pi-tui env-default reconfiguration + theme-key moves (zero references
— measured); prompt-cache ttl handling (no explicit-cache-mode model in config —
measured); GPT-6 Astra / new presets exposure (catalog entries flow through
modelRegistry automatically for configured providers; presets are user-applied
templates — adding an OpenAI preset has no demand and violates the
GLM-first stack, D3); restorable child sessions via `inMemory(cwd, {id}, entries)`
(CHARTED — successor-arc material, D8); reopening steer semantics (arc-23
boundary stands); SessionWorker/coordinator/RPC-mode orchestration (upstream
experimental; our in-process architecture + subprocess isolation already covers
the need — charted in Fog of war); `todo.ts`/plan-mode/handoff ports (owned by
other exts, not subagent's surface).

## Tickets

### Phase 1 — upgrade (lands FIRST; everything builds on 0.85.1)

**t01 — pi 0.84.4 → 0.85.1 bump + fallout**
Package: repo-wide (29 package.json files); gates: every `bun-apps/*` package's
canonical test script via `local-ci` (upgrade touches every package's deps —
run the full chain, not a subset).

- Work: scoped sed `0.84.4` → `0.85.1` in every `@earendil-works/pi-*` pin
  (deps + peerDeps); `bun install` from `bun-apps/` (lockfile recomputes:
  `@earendil-works/chord` enters transitively, pi-client/pi-protocol leave);
  fix any type fallout (expected ∅ per evidence, but the compiler decides).
- Verification (explicit, from the brief):
  (a) typecheck/test across EVERY bun-apps package (local-ci full run);
  (b) repo-wide grep of tests for write-tool byte-count assertions — measured
  none in subagent/core-runtime; sweep the rest and fix any red;
  (c) setModel/setThinkingLevel audit — measured: `presets.ts:11` contract
  MATCHES 0.85 semantics; confirm no other real call site (test mocks exempt);
  (d) model registry: `--list-models` shows the zai glm set; a live
  `--model zai/glm-5.3` headless one-shot (print mode, tiny prompt) answers —
  the smoke, not a port (zai.json measured byte-identical);
  (e) confirm `agent-baked-providers-seam.test.ts` +
  `pre-load-providers.test.ts` green unchanged.
- PR mechanics: devops chain (prepare-feature-branch → local-ci →
  merge-pr-after-ci); `version-bump-cli --package s2-agent --patch` at merge
  (t01 edits `bun-apps/s2-agent/package.json`).
- Deployed-verification contribution: the upgraded core bundle itself — t06
  greps the 0.85.1 version string in the shipped `s2-agent.js` and runs
  verify-deploy-e2e green.
- Done-when: all packages green on 0.85.1, smoke receipt under `evidence/`.

### Phase 2 — subagent upstream-parity (each independently mergeable; order t02 → t03 → t04 → t05)

**t02 — child-output cap + details full-preserve (upstream `PER_TASK_OUTPUT_CAP` parity)**
Package: `bun-apps/s2-agent-ext-subagent` (+ core-runtime only if the cap
constant's home demands it); files: `subagent-tool.ts` (content path :733,
`SubagentToolDetails` gains the full `output`), `subagents-tool.ts`
(`renderBatchResult` per-slot cap), `subagent-tool-run.ts` (shared
`capChildOutput` helper + marker line, e.g. `… output capped at 50KB for the
parent — full output preserved in tool details / list_subagent_runs get`).

- Work: export `CHILD_OUTPUT_CAP = 50 * 1024` (bytes, string length is
  acceptable — document the unit); cap the parent-visible content in BOTH
  tools (singular content; per-slot batch body) at the boundary with a
  truncation marker that names where the full text lives; `details.output`
  carries the full text (UI expand); durable record unchanged (already full).
  Salvage paths (`extractSalvage`) untouched — they have their own caps.
- Tests: cap boundary matrix (49KB/50KB/51KB × singular/batch), marker-line
  presence, details-vs-content split, failure slots unaffected, existing
  golden renders unchanged when under cap.
- Schema-cost: tool descriptions unchanged → no canary action (state the check
  in the PR body).
- Deployed-verification contribution: the marker string is the t06 bundle
  grep-assert target (PB-09 — string literals survive minification) + a t06
  driven child producing > 50KB output shows the marker in the parent result.
- Done-when: a > 50KB child output yields capped parent content + full
  details, unit-proven; grep-asserted on the deployed bundle.

**t03 — ctx.cwd delegation: verify-then-simplify (honest no-op exit)**
Package: `bun-apps/s2-agent-core-runtime` + `s2-agent-ext-subagent` test;
files: `agent.ts:358-361` (the `createCodingTools(runCwd)` re-binding),
comment updated either way; new A/B test in `core-runtime/tests/`.

- Step 1 (probe, BEFORE any change — PB-10 pre-fix receipt): spawn an
  in-process child via `WorkflowAgent.run` with `cwd` ≠ the CoreAgent's own
  cwd; exercise `read` (relative path) and `bash` (relative cwd + `pwd`) on
  0.85.1. Record the observed resolution base (session cwd vs construction
  cwd) with the test output committed under `evidence/`.
- Step 2: if ctx.cwd wins → delete the :361 re-binding (always
  `this.baseTools`), keep `SettingsManager.create(this.cwd, …)` (user-level,
  deliberate); if construction cwd still wins (e.g. the embedded path does not
  thread session cwd into tool ctx) → KEEP the workaround, flip the comment to
  cite the probe evidence, exit as documented no-op.
- Guardrail: extension tools passed to child sessions (`customTools`,
`extensionTools`) resolve their own paths — verify at least one (e.g. a
subagent-family tool) still resolves correctly post-simplification; worktree
`spawnCwd` flows through `createCodingTools(runCwd)` only via runCwd — the
worktree path remains a process/git concern, not touched.
- Tests: the A/B test stays as the regression pin either way; full package
  gates + local-ci.
- Deployed-verification contribution: t06 drives one cwd-mismatch child on the
  deployed tree (scratch repo + a sibling dir fixture).
- Done-when: probe evidence committed; EITHER the simplification landed with
  the A/B test green, OR the no-op documented with the measured reason.

**t04 — project-agent trust gate (upstream parity; `hasUI=false` policy explicit)**
Package: `bun-apps/s2-agent-ext-subagent`; files: `subagent-tool.ts` +
`subagents-tool.ts` (gate at agentType resolution, after
`resolveAgentType`), shared predicate in e.g. `agent-type-catalog.ts` or a
small `agent-trust.ts`; `agent-registry.ts` UNCHANGED (loading stays; the
gate is at BIND time in the parent, which owns the UI).

- Policy (D6): a resolved `def.source === "project"` in a project where
  `!ctx.isProjectTrusted()`: hasUI → `ctx.ui.confirm("Run project-local
  agents?", …)` naming the files; no-UI (headless children, batch, json mode)
  → default-DENY with an error naming the file and the trust command. User /
  pack / builtin sources never gate. Batch: whole-batch failEarly listing
  offending indexes (matches the existing unknown-type failEarly shape).
- Tests: matrix (source tier × trusted/untrusted × hasUI/no-UI), batch
  failEarly shape, confirm-decline path, gate skipped when trusted.
- Schema-cost: no description change expected; state the check.
- Deployed-verification contribution: t06's scratch repo is UNTRUSTED by
  default — a planted `.pi/agents/evil.md` agentType attempt returns the deny
  error (headless) — the receipt IS the policy proof.
- Done-when: matrix green; deny receipt captured on the deployed tree.

**t05 — per-message usage ledger: land-or-dated-reject**
Package: `bun-apps/s2-agent-core-runtime` + `s2-agent-ext-subagent` IF landed.

- Adjudication (D7): the budget layer already observes usage per API response
  (`agent-budget.ts:103-106`, same getSessionStats source). Landing = plumb a
  `onUsageDelta` (or reuse the existing observation) into dispatchChild's
  snapshot/onHistory feed so the live viewer Σ ticks per message, + turns
  count on the settled line. If it needs MORE than one new seam through
  dispatchChild/spawn options → REJECT with a dated reason citing this map;
  commit the probe note under `evidence/`.
- Tests (if landed): delta aggregation ≡ final usage at completion; viewer
  snapshot carries running totals; no regression to completion-time onUsage.
- Deployed-verification contribution (if landed): t06's driven run shows the
  live Σ ticking mid-run in the transcript receipt; else the reject memo.
- Done-when: landed with tests, or the dated REJECT is in the map's Decisions
  with the committed probe note.

### Phase 3 — deployed verification (receipts-only, no PR)

**t06 — deployed verification leg: pinned deploy, isolated work env, receipts**
Pattern: arc-24 t05 (scratch git repo + worktree isolation + headless drive),
discipline: arc-23 t03 (pre-drive bundle greps).

- Deploy via `deploy-cli` to a PINNED immutable version dir (never `current` —
  PB-08; resolve-and-record if any leg must touch it). BEFORE driving,
  grep-assert (PB-09; learning #1 — property names / string literals, not
  locals): the pi 0.85.1 version string in `s2-agent.js`; t02's cap marker
  string in the ext bundle; t04's deny/trust strings; (if t05 landed) the
  delta-ledger symbol. Also verify the core cache MISSED (pi version is in
  `computeCoreHash` — a hit here means the cache is broken, stop and receipt).
- Isolated work env: throwaway scratch git repo under `output/` (per-worktree
  gitignored scratch); drive the DEPLOYED CLI inside it. Scenarios: (a) a
  GLM-5.3 child dispatch (singular) with cwd ≠ parent cwd (t03 proof);
  (b) a > 50KB-output child → parent sees marker + capped body (t02 proof);
  (c) planted `.pi/agents/evil.md` agentType → headless deny (t04 proof);
  (d) model proof: `zai/glm-5.3` on every LLM leg, flash excluded BY NAME
  (PB-12-style passive attribution: record model per leg in the receipt).
  Worktree isolation proof if any scenario isolates (commit lands on the
  worktree branch; scratch main clean; parent repo `git status` clean).
- tui-drive discipline (learnings #3/#4/#5): `TERM=xterm-256color`, ~64-byte
  awaited chunks, primary DA reply + kitty silence, real wall-clock sleeps
  after dialog mounts, settle judged ONLY on live markers.
- Receipts → `evidence/deployed-verification/` (committed; PB-18; caps
  ≤256KB/file). Never delete a failing leg (PB-13); cap retries ≤2 per scenario
  and record a dated defer rather than thrashing (PB-14); unreachable surface
  = recorded gap, never a pass (PB-15).

**t07 — close-out**
Map Shipped-as (merged PR numbers) + `status:` flip in the SAME PR (PB-05);
`effort-audit.ts` exit 0; ledger `mergedPr` filled; reciprocal back-links on
touched maps (Builds-on: self-arc-23/24 patterns; Shares-decision-with:
self-arc-12 D5 model policy); playbook curation at close (new PB entries only
if this arc earns one — e.g. the ctx.cwd probe pattern); successor next-goal
written to the strict v2 shape, validated (exit 0), LATEST symlink repointed
AFTER validation, doctor run (PB-03/PB-04).

## Decisions

- D1 (2026-09-14): upgrade risk is adjudicated by MEASUREMENT, not the
  changelog: root-only imports (grep), zero removed-and-used symbols
  (tarball diff), zero pi-tui/theme/prompt-cache references (grep), zai.json
  byte-identical (tarball diff), presets' TRANSIENT BY CONTRACT matching 0.85's
  session-scoped setModel (code read). The remaining unknowns are exactly the
  Fog-of-war items; t01's gates + smoke are the proof, not a port.
- D2 (2026-09-14): the cap constant is 50KB per child, applied at the
  parent-visible content boundary in BOTH tools, with the full text in
  `details` + the already-full durable record (upstream `PER_TASK_OUTPUT_CAP`
  parity). Per-BATCH aggregate budgets are NOT added this arc — the per-slot
  cap plus existing batch tokenBudget soft gate cover the economics; keep the
  ticket small.
- D3 (2026-09-14): model presets stay untouched. Catalog additions (GPT-6
  Astra etc.) flow through modelRegistry for users who configure those
  providers; adding presets for them contradicts the GLM-first stack and has
  no demand. Registry freshness = t01's verification items (d)/(e).
- D4 (2026-09-14): t03 is verify-then-simplify with an honest no-op exit
  (arc-24 t04 pattern): the probe evidence is committed either way; a
  documented "keep the workaround because the embedded path threads
  construction cwd" is a valid terminal state.
- D5 (2026-09-14): t05 is land-or-dated-reject, threshold = one new seam.
  A P2 nicety never justifies a three-file plumb this arc (PB-14 discipline).
- D6 (2026-09-14): trust-gate policy mirrors upstream exactly for the confirm
  branch and our own timeout-default-DENY precedent for the no-UI branch:
  project-source + untrusted + hasUI → confirm; project-source + untrusted +
  no-UI → default-DENY naming the file. Trusted projects and user/pack/builtin
  sources never gate. Registry loading is unchanged — the gate binds at
  dispatch, where the parent owns the UI.
- D7 (2026-09-14): PR structure — t01 lands FIRST and alone (every later
  ticket builds on 0.85.1); t02–t05 are independently mergeable PRs in that
  order via the devops chain; collapsing adjacent tickets into one PR is
  allowed only when their diffs share files, and the PR body must say so.
  Version bump at t01 merge (s2-agent package.json pins change) and again at
  the LAST implementation PR so the t06 deploy label names the newest bytes.
- D8 (2026-09-14): restorable child sessions (`inMemory(cwd, {id}, entries)`)
  are CHARTED, not ticketed: persistent children hold transcripts in-process
  (`persistent-agent.ts`); journaling `FileEntry[]` + restore-on-parent-restart
  is a new persistence layer — honestly a successor arc. The opt-in signature
  change is backward compatible (we call `inMemory()` no-args today,
  `agent.ts:446`), so deferring costs nothing.
- D9 (2026-09-14): model policy unchanged — GLM-5.3 everywhere, never flash;
  receipts exclude flash BY NAME (shares self-arc-23 D6 / self-arc-12 D5).
- D10 (2026-09-14): receipt discipline — pinned version dirs (PB-08),
  pre-drive bundle greps (PB-09), pre-fix/pre-change probe receipts (PB-10),
  pre-registered scenario checks before running legs (PB-11), failing legs
  preserved (PB-13), committed `evidence/` paths for every verdict (PB-18).

## Frontier

`t01` first, alone: every later ticket compiles against 0.85.1 behavior (t02's
marker rides the new bundles, t03's probe is only meaningful on 0.85.1, t04's
gate lands on the upgraded tree, t06 deploys the whole stack). t02 → t03 → t04
→ t05 afterwards (t02 and t04 are fully independent; t03 touches agent.ts which
t02's tests exercise — sequential keeps the diffs clean). t06 after ALL
implementation PRs merge; t07 last.

## Fog of war

- Whether the embedded `createAgentSession` path threads the session cwd into
  the tool-execution ctx (`ctx.cwd`) — the load-bearing unknown for t03.
  Upstream's fix covers the seven built-ins' tool factories; our sessions
  construct tools at CoreAgent level and pass them in (`customTools`). The
  probe decides; both exits are acceptable (D4).
- Whether extension tools handed to child sessions resolve relative paths
  against construction cwd — if they do, t03's simplification must not break
  them (guardrail pinned in the ticket).
- The `--mode json` event surface deltas (message_update cumulative-snapshot
  drop, queue_update) — our only JSON consumer parses `message_end`
  (`spawn-subagent-subprocess.ts`); confirm during t01's full gate run that no
  other consumer exists (grep + tests).
- RPC abort-waits-for-idle and fork/compaction-boundary fixes: we do not drive
  RPC abort paths in-repo today (grep this session found none); fork flows via
  `fork-transcript-getter` — covered by t01 gates, no dedicated ticket.
- Deploy timing for t06 — irrelevant: t06 deploys explicitly (arc-19 D5
  pattern); sibling worktrees never touched.
- Whether the deployed TUI shows any visual delta from 0.85's embedded working
  indicator (editor-border spinner) — cosmetic; t06's drive receipts will show
  it if visible; no action unless a scenario breaks.

## Successor next-goal sketch (t07 writes the real one, strict v2)

Queue head candidate: restorable child sessions (D8) — journal persistent
children's `FileEntry[]` via `SessionManager.getEntries()` + restore through
`inMemory(cwd, {id}, entries)` on parent restart, sized as its own arc. Other
in-scope re-checks: the t05 reject (if rejected) re-priced after the dispatch
seam next moves; t06 receipts' recorded gaps; the charted-but-untouched
upstream patterns (SessionWorker/coordinator, RPC-mode child steering) re-read
against whatever pi ships next. Focus scope stays the subagent +
deploy-truth axis; out-of-scope items enter only when they BLOCK in-scope work.

## Shipped-as

- **t01** — #2277 (squash `38809001`): pi 0.84.4 → 0.85.1 across 29 package.json files; lockfile recomputed (chord in, pi-client/pi-protocol out); all 29 packages typecheck clean; core-runtime 508/0; ext-subagent 854/0; `zai/glm-5.3` list-models + live headless smoke (Bravo851).
- **t02** — #2278 (merge `6e88ebf3`): CHILD_OUTPUT_CAP=50KiB + OUTPUT_CAP_MARKER (output-cap.ts); singular content capped with full text in details.output; batch per-slot render cap; 8 boundary tests; 862/0.
- **t03** — #2279 (merge `0c86ad35`; branch head 4fc1b15b + biome fix): createCodingTools(runCwd) re-bind REMOVED; tests/cwd-delegation.test.ts drives REAL loop turns with a scripted stream — session cwd threads into built-ins AND customTools (canary observes ctx.cwd === B); 511/0; ext-subagent 862/0; app 1051/0.
- **t04** — #2280 (`c247f2d3`): agent-trust.ts gate (confirm/no-UI-deny policy per D6) at dispatch-bind in both tools; AgentDefinition.fileName (additive) in core-runtime; 10 tests; 872/0. Gate LATENT in host — see Corrections.
- **t05** — #2282 (`9eb78efe`): LAND per D5 (zero new seams) — AgentHistoryEntry.usage projection (first-entry attachment) + monotone per-tick accrual with completion remainder settlement; 4+1 tests; core-runtime 511/0; ext-subagent 876/0.
- **t06** — receipts only (no PR): `evidence/deployed-verification/` on pinned `0.10.3+g9eb78ef`; scenarios (a)/(b)/(d) PASS, (c) gate-latent gap recorded; pre-drive greps green.
- **t07** — this close-out PR.

## Corrections to planning-phase claims

1. **t04's gate is LATENT in the host (deployed-verification finding).** The map's Context asserted the trust gate would bite ("a planted .pi/agents/evil.md agentType attempt returns the deny error — the receipt IS the policy proof"). Deployed scenario (c) disproved the ENVIRONMENT premise, not the policy: pi's library SettingsManager defaults `projectTrusted = true` and the host never runs `resolveProjectTrusted()`, so `ctx.isProjectTrusted()` never reports false. Policy unit-tests stand; the missing piece is HOST trust wiring — charted as the successor-arc head with the probe evidence (`evidence/deployed-verification/README.md` scenario (c)).
2. **CI-gate chain ordering slip (process, not product).** PR #2280: I chained the merge CLI after a local-ci run whose FAIL verdict I read only afterwards (grep-based gating instead of exit-code gating). The merge CLI had run its own fresh CI (green) before merging; the locally failing leg (win32-x64 cross-deploy e2e) passed on immediate re-run on the merged tree — flake under concurrent load. Lesson: never chain merge behind anything but the programmatic overall verdict (adopted from #2282 onwards).
3. **t01's done-when smoke receipt was missing at the t01 PR** (reviewer B2): the "Bravo851" smoke existed only as a PR-body line. Reparied at close-out: `evidence/t01-smoke-deployed.log` re-runs the identical one-shot against the DEPLOYED pinned tree `0.10.3+g9eb78ef` (exit 0 -> "Bravo851"), which also chains custody: deployed tree => commit 9eb78efe => bun.lock 0.85.1.
4. **D7's version-bump promise was skipped at every merge** (reviewer B3): five PRs, zero bumps; s2-agent stayed 0.10.3 while its pins changed. Reparied at close-out: `version-bump-cli --package s2-agent --patch` (0.10.3 -> 0.10.4) lands in THIS close-out PR, so the next deploy label names new bytes. D7's "bump at t01 merge" would have been redundant mid-arc — the honest rule the loop should keep is "bump once per arc at close-out when s2-agent/** changed" (recorded for playbook curation).

5. **Held claims:** REMOVED-and-USED = ∅ held (zero upgrade fallout — the compiler never saw a removed symbol); zai registry byte-identical held (zai/glm-5.3 smoke + deployed model-call leg green); t03's "both exits acceptable" resolved to SIMPLIFY with in-CI probe tests; t05 landed within the one-seam threshold.

## Cross-effort links

Builds-on: `2026-09-10-self-arc-23-subagent-steer-deploy` (deploy-truth
machinery this arc's t06 leans on: hash-completeness, link self-heal,
pre-drive greps; steer boundary stands), `2026-09-11-self-arc-24-ultracode-cc-parity`
(the deployed-verification leg pattern t06 copies: pinned deploy + scratch-repo
isolation + probe-exit tickets).
Shares-decision-with: `2026-09-06-self-arc-12` D5 → self-arc-23 D6 (GLM-5.3-only
model policy — D9).
Sibling-not-touched: `../video_generation__memory`, `../video_generation__movie`.
Reciprocal back-links added at close-out (t07).
