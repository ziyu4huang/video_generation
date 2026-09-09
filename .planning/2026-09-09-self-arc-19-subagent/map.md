---
effort: 2026-09-09-self-arc-19-subagent
created: 2026-09-09
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-09-self-arc-19-subagent — harness truth-chain + steer surface + depth cap

Plan diagram: `plan.svg` (this folder). Audited against origin/main `6d225ca2` in THIS
worktree (branch `self-arc-19-subagent`); every file:line below was read by the planner
on 2026-09-09.

## Destination

ext-subagent where the TUI-drive harness cannot lie and the model can actually steer:
(1) `tui-drive.ts` judges the live call row wrap-tolerantly, stamps every receipt with
launcher provenance (sh realpath + deployed version + git sha), gates ALL scenario
submits on a rendered-truth boot check, and sources every UI-vocabulary regex from one
exported table pinned by a unit test — so one pi-tui wording change fails one table
test, not every LLM scenario; (2) `list_subagent_runs` grows a `steer` verb exposing the
proven `deliverAs` wake seam to the model by RUN ID; (3) nested non-fork spawns are
depth-capped (default 2, per-agentType `maxDepth` frontmatter override) with a clean
rejection; (4) deployed receipts PASS with `liveModelSlot` latching on the deployed
tree, and steer + depth-cap are receipted on a freshly deployed tree; (5) arc-13/14
stale map statuses flipped in a docs close-out PR with a validated successor next-goal.

## Context

Measured 2026-09-09 in this worktree (branch `self-arc-19-subagent` at `6d225ca2`),
read by the planner (grep/sed, not assertion):

- **liveModelSlot false-FAIL mechanism** — `scripts/tui-drive.ts:378-382`: the latched
  in-loop check does `for (const line of screen()) { if (!line.includes("spawn_subagent")) continue; … if (/glm-5\.3/.test(line)…) }`
  — tool name AND model must sit on ONE physical line. Receipted: deployed dispatch run
  `output/self-arc14-deployed-dispatch-20260908/snap-10-running.txt` line 24 ends
  `… ▸ glm-5.3 ▸` and line 25 is a bare `spawn_subagent` continuation (COLS=100 wrap);
  that receipt.json's check keys contain `sawTaskLine`/`liveRow` but NOT `liveModelSlot`
  — the check never latched. This is the arc's headline false-FAIL.
- **Receipt has no launcher provenance** — `Receipt` interface at `scripts/tui-drive.ts:316-327`:
  fields `scenario/cwd/startedAt/bytesSeen/snaps/modelLine/checks/pass` only. No `--sh`
  path, no realpath, no deployed version, no git sha; "deployed vs source" lives only in
  the output folder name. Confirmed against the deployed receipt.json key set.
- **Rendered-truth boot gate is partial** — exists only in cc-parity (`tui-drive.ts:691-713`,
  comment: "Deployed hosts render LATE: waitIdle alone can return mid-load") and reload;
  the bare `await waitIdle(2500, 45000)` submit pattern remains at `tui-drive.ts:339,
  438, 487, 640, 697, 810, 895` (+ the last scenario past the grep head) — 8 LLM
  scenarios can submit into an unrendered screen (first-Enter-eaten class, PR #2208
  already fixed two of them the hard way).
- **UI vocab is scattered literals** — live-marker regex `Working\.\.\.|esc to interrupt|[⠋⠙…]`
  duplicated 4× (`tui-drive.ts:368,456,1146,1201`); `⌛ running` at 502/526/656;
  `bg\s{2,}●` at 603/656; `Abort this subagent\? y\/N` at 572/860/870; `‖` at 959;
  `◆` at 835/923/979; `Agent types` at 1020; `y confirm delete` at 1091. One pi-tui
  wording change fails every LLM scenario at once.
- **Steer seam exists, unexposed by run-id** — `pi.sendMessage` opts already admit
  `deliverAs?: "followUp" | "nextTurn" | "steer"` (`src/background-run-manager.ts:194`,
  `src/parent-message-bus.ts:93`), but both wirers hardcode `followUp`+`triggerTurn`
  (bgm:203, pmb:103). `send_message` DOES steer NAMED team agents mid-exchange
  (`src/send-message-tool.ts:312-313`, `result.steered`) — the gap is steering a
  BACKGROUND RUN by id: `list_subagent_runs` owns list/get/wait/stop
  (`src/subagent-runs-tool.ts:241-258`) and has no steer verb.
- **Depth cap absent outside fork recursion** — the only recursion guard is the fork
  child scope (`src/subagent-tool.ts:435-448`, `isForkChild`/`runAsForkChild`; its own
  comment documents that fork-child scope inheritance covers grandchildren). Non-fork
  grandchild spawns are uncapped. `src/agent-type-catalog.ts` is only the catalog
  FORMATTER (CATALOG_HEADER etc.) — the agentType def frontmatter parser lives
  elsewhere (t03 locates it; tui-drive seeds defs with `model: zai/glm-5.3` frontmatter
  at `tui-drive.ts:128,164`, so a parser exists and is exercised live).
- **Deployed tree** — `/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`
  = `0.10.0+g80419f1` (self-arc-12 Shipped-as sweep ran 10/10 on it). t01 is
  script-side only (the script runs FROM the worktree against any `--sh`), so its
  receipt is valid on this tree NOW; t02/t03 runtime code lands only in the NEXT
  deploy.
- **Stale statuses** — `.planning/2026-09-06-self-arc-13/map.md` frontmatter
  `status: planning`, `.planning/2026-09-06-self-arc-14/map.md` `status: active`, both
  done with Shipped-as; their `2026-09-08-*` successors are already `status: done`
  (read 2026-09-09).
- **Sibling worktree** — `/Users/huangziyu/proj/video_generation__memory` (branch
  self-arc-18) is ACTIVE; untouched by this arc. `plan.svg` already at this effort root.

## Scope decision

IN: the four P0 harness truth-chain items (tui-drive.ts only), the steer verb
(list_subagent_runs, schema-cost delta generated + cited), the depth cap (spawn context
+ def frontmatter override), deployed receipts (t04, per D5's redeploy decision), and
the docs close-out (status flips + successor next-goal). CHART-ONLY (do NOT implement):
cross-OS tui-drive leg; writable fan-out with worktree isolation
(`feat/self-arc-13-b3-migrate` branch exists — recorded in Fog of war for a successor
arc). OUT: any change to send_message's named-agent steer path; any pi-tui change
(vocab table absorbs wording drift, it does not freeze upstream).

## Tickets

**Phase 1 — implementation (ONE PR: t01+t02+t03, devops chain)**

- [x] `tickets/01-harness-truth-chain.md` — t01: wrap-tolerant liveModelSlot, launcher
      provenance in Receipt, exported boot gate before every submit, exported UI_VOCAB
      table replacing all scattered literals, unit test pinning the table (tui-drive.ts
      + one test file; schema-cost +0 by construction)
- [x] `tickets/02-steer-verb.md` — t02: `list_subagent_runs` action `steer {id, message}`
      → live run lookup → deliverAs wake seam; tests with a fake background run;
      schema-cost delta generated and cited
- [x] `tickets/03-depth-cap.md` — t03: spawn-context depth counter (default max 2) +
      agentType def frontmatter `maxDepth` override + clean rejection + tests; fork-guard
      interplay documented

**Phase 2 — deployed verification (after the implementation PR merges)**

- [x] `tickets/04-deployed-receipts.md` — t04: redeploy via deploy-cli (D5), then
      `tui-drive --sh <dist>/current/s2-agent.sh` dispatch (liveModelSlot LATCHING is
      the wrap-fix proof) + steer evidence + depth-cap evidence; provenance stamped in
      every receipt

**Phase 3 — close-out (separate docs PR)**

- [x] `tickets/05-closeout.md` — t05: flip `2026-09-06-self-arc-13/14` statuses,
      reciprocal back-links, map done + Shipped-as, successor next-goal (strict v2)

## Decisions

- D1 (2026-09-09): t01 stays tui-drive.ts-ONLY plus one unit test file — the vocab
  table and boot gate are exported FROM `scripts/tui-drive.ts`, and the script's main
  entry is guarded (`import.meta.main`) so tests can import it without side effects.
  No shipped-runtime change ⇒ schema-cost +0 by construction; the PR body says so
  explicitly (self-arc-12 D7 pattern).
- D2 (2026-09-09): wrap fix joins continuation lines, not widens COLS — for each line
  carrying `spawn_subagent`, the model-segment test runs against `lines[i-1]+lines[i]`
  and `lines[i]+lines[i+1]` (both wrap directions), keeping the flash-exclusion and
  `sawTaskLine` semantics unchanged. COLS stays 100: wrapping is the real render at
  real widths; widening would un-test the very shape users see.
- D3 (2026-09-09): receipt provenance block `launcher: { sh, shRealpath, deployedVersion?,
  gitSha, tree }` — realpath via `fs.realpathSync`, gitSha via `git rev-parse HEAD` in
  cwd, deployedVersion best-effort (`<sh> --version` capture; if that flag does not
  exist, parse the dist `current` version-dir label; absent ⇒ `null`, never a hard
  fail). Tree = "source" | "deployed" derived from whether `--sh` was passed.
- D4 (2026-09-09): boot gate = exported `awaitBootRendered(timeoutMs)` — poll until the
  screen is non-empty AND free of boot-flash artifacts, using the cc-parity precedent
  (`tui-drive.ts:691-713`) generalized; every scenario calls it BEFORE submit and keeps
  `waitIdle` after. Never delete the per-scenario settle logic — the gate is additive.
- D5 (2026-09-09): t04 REDEPLOYS via deploy-cli before the drive (option (a)), because
  a receipt should prove the shipped artifact, not the source tree wearing a dist path
  (learning #1: verify the artifact, then trust the label). verify-deploy-e2e runs
  automatically post-deploy. Fallback only if deploy is broken: mark steer/depth-cap
  checks `source-tree-only: true` in the receipt with a one-line reason — never silently.
- D6 (2026-09-09): steer verb targets RUNS, send_message keeps NAMES —
  `list_subagent_runs({action:"steer", id, message})` looks up the LIVE run and
  delivers via the proven wake seam (`deliverAs:"steer"` where the host supports it,
  falling back to `followUp`+`triggerTurn` exactly as both wirers do today). No overlap
  with send_message's named-agent mid-exchange steer; the tool description says so.
- D7 (2026-09-09): depth counter propagates through the spawn context (ambient scope or
  env, whichever the existing dispatch seam already carries — t03 verifies), default
  max 2, per-agentType `maxDepth` frontmatter override; rejection message names the
  current depth, the cap, and the override knob. The fork guard is NOT replaced — fork
  recursion stays rejected by scope; the depth cap governs non-fork grandchildren.
- D8 (2026-09-09): PR structure per directive — ONE implementation PR (t01+t02+t03)
  through prepare-feature-branch → local-ci → merge-pr-after-ci → verify scope;
  version-bump ONLY if `bun-apps/s2-agent/**` changes (ext-only ⇒ no bump). ONE docs
  close-out PR (t05). t02's PR body MUST cite the generated schema-cost delta
  (`bun bun-apps/s2-agent/src/cli.ts tools-metrics --schema-cost --json`).
- D9 (2026-09-09): model policy unchanged — planner/children zai/glm-5.3, never flash;
  receipt checks keep excluding flash BY NAME (shares self-arc-12 D5, narrowed the same
  way). `output/` is scratch; receipts are never committed.

## Frontier

`tickets/01-harness-truth-chain.md` first: it is a dev script plus a test — zero
production code, zero schema delta, and it un-blocks trustworthy receipts for t04
(provenance + wrap fix are preconditions for believing ANY later deployed evidence).
t02 and t03 are independent of each other but both want t01's honest harness for their
eventual receipts, so they follow in the same PR.

## Fog of war

- The exact injection seam for steering a LIVE background run by id (registry → child
  session handle → sendMessage) — the wirers deliver notifications, not arbitrary
  operator text; t02 verifies whether the live registry exposes the child session or a
  manager method must be added (tests use a fake background run either way).
- Where agentType def frontmatter is parsed (maxDepth must attach there).
  `agent-type-catalog.ts` is the formatter only; `model:` frontmatter parsing was
  proven to exist by tui-drive's seeded defs, but its file was not located this session.
- Whether `<sh> --version` answers on the deployed script (D3's best-effort
  provenance path); if not, the dist version-dir label parse is the fallback.
- Cross-OS tui-drive leg — charted, NOT taken (no Linux receipt path today; xterm
  byte-feeding learnings are darwin-specific). Writable fan-out with worktree isolation
  — charted, NOT taken; `feat/self-arc-13-b3-migrate` branch exists for a successor arc.
- Deploy timing: whether the next routine deploy lands before t04 — D5 makes this
  irrelevant by deploying explicitly.

## Shipped-as

- t01+t02+t03 — PR #2244 (squash `88406114`, branch `self-arc-19-subagent`):
  scripts/lib/tui-drive-lib.ts (UI_VOCAB + wrap-tolerant judge + boot gate),
  launcher provenance in receipt.json, boot gate in all 10 scenarios,
  `steer` verb on list_subagent_runs (InFlightSubagent.steer lever, named
  dispatches), nested-spawn depth cap (core-runtime spawn-depth.ts, default
  2, per-def `maxDepth` frontmatter, round-tripped by the /agents writer).
  schema-cost: list_subagent_runs 369→488 approx tokens (total 25792→25942).
- t04 receipts (this worktree `output/`, all glm-5.3 children):
  - `self-arc19-deployed-dispatch-20260910/` — **PASS**, `liveModelSlot`
    LATCHED on the deployed tree (the wrap-fix proof; baseline false-FAIL:
    `output/self-arc14-deployed-dispatch-20260908/`), receipt.launcher =
    {tree:"deployed", deployedVersion:"0.10.3+g8840611", shRealpath resolved}.
  - `self-arc19-deployed-agents-20260910/` — **PASS 11/11** (vocab-table
    migration: zero check-name drift).
  - `self-arc19-deployed-steer-depth-20260910-r2/` — depth cap **PROVEN
    live**: level-3 spawn rejected verbatim "depth 3 would exceed maxDepth 2";
    steer verb executes end-to-end (schema+lever+delivery) — see F-steer-1.
- t05 — this docs PR; arc-13/14 map statuses flipped (done).

## Loop findings (develop → deploy → drive → issue → develop)

- **F-harness-wrap (t01, fixed)** — single-line liveModelSlot judge
  false-FAILED the wrapped call row; receipted 09-08, fixed by the joined
  neighbor-pair judge (map D2), proven by the 09-10 deployed dispatch receipt.
- **F-deploy-1 (t04, CHARTED — deploy pipeline)** — a fresh `deploy-cli` run
  at the new sha served STALE bundles: ext/subagent/ext.cjs lacked the steer
  strings entirely and the core bundle lacked t03 (content-cache entries
  reused across source changes; "same git sha means same content" no-op logic
  also assumes sha⇒content). Workaround proven: `--no-freeze --force` rebuilds
  fresh (verified by artifact-string grep BEFORE driving — learning #1
  applied). Follow-up: key the bundle caches on source content hashes and
  grep-assert new symbols post-deploy in verify-deploy-e2e.
- **F-steer-1 (t04, CHARTED — steer semantics)** — steering a background run
  during its TOOL-EXECUTION window (not mid-model-exchange) reports
  "ran as a fresh turn" but the guidance never reached the child's output
  (r2 drill: sleep-90 child completed without the steered instruction).
  PersistentAgent mid-flight detection covers model exchanges only. Follow-up:
  surface queued-turn semantics to the caller (or deliver tool-window steers
  after the current tool completes) + a steer drill scenario.
- **F-gate-wedge (infra, FIXED in #2245)** — the L1 deploy-e2e run() helper
  wedged to bun's 900s cap when a killed child's descendant held the stdout
  pipes; run() now deadline-races reads, reaps descendants, and returns
  partial output (the fix that unblocked this arc's own merge).

## Cross-effort links

Builds-on: `2026-09-06-self-arc-12` (tui-drive scenario + receipt discipline; its PR
#2208 shipped the FIRST boot gates this arc generalizes; D1/D7 patterns reused),
`2026-09-06-self-arc-9` (liveModelSlot lineage and child-evidence gating),
`2026-09-08-self-arc-14` (qualify/deployed sweep receipts — the false-FAIL receipt
folder this arc fixes), `2026-09-08-self-arc-13` (worktree-isolation chart item).
Shares-decision-with: `2026-09-06-self-arc-12` D5 (glm-5.3-only model policy — D9).
Sibling-not-touched: self-arc-18 in `../video_generation__memory` (active, independent).
Reciprocal back-links are added to those maps at close-out (ticket 05).
