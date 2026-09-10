---
effort: 2026-09-10-self-arc-22-subagent-steer-deploy
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-self-arc-22-subagent-steer-deploy — stale-bundle deploy truth + tool-window steering

Planned 2026-09-10 in THIS worktree (`video_generation__subagent`, branch `self-arc-22`
at `61688652`, verified cut). Ledger number 22 claimed in `.planning/arc-ledger.json`
(this branch). Every file:line below was read by the planner on 2026-09-10 unless
attributed to the arc-19 evidence chain.

## Destination

A deploy whose label says "fresh" provably IS fresh, and a steer that answers honestly
also lands: (1) every deploy cache keys on the source bytes the bundler actually
RESOLVES, a pre-build gate stats through the `node_modules/@repo/*` link farm (the
learning-#2 class), and verify-deploy-e2e grep-asserts distinctive markers from the
hashed sources in every rebuilt bundle — so a stale serve fails the deploy, red, with
grep counts, instead of shipping; (2) `list_subagent_runs` steer in a child's
TOOL-execution window is detected (a third live-agent state), delivered as a queued
turn GUARANTEED to drain after the current exchange, and the reply says exactly which
of the three outcomes happened; (3) both receipted on a REDEPLOYED tree whose bundles
were grep-asserted BEFORE driving (arc-19's lesson, now mechanized); (4) docs close-out
PR flips statuses and writes the successor next-goal.

## Context

Measured 2026-09-10 in this worktree (branch `self-arc-22` at `61688652`), read by the
planner (grep/read, not assertion), except where attributed:

- **F-deploy-1 evidence (arc-19 map, Loop findings — receipted 2026-09-10)**: a
  fresh-sha `deploy-cli` run at `8840611` shipped `ext/subagent/ext.cjs` WITHOUT the
  steer strings (grep `"not steerable"` = 0) and a core bundle without t03; the run
  printed `Bundled 2556 modules in 107ms`. `--no-freeze --force` redeploy rebuilt
  fresh (both greps = 1 AFTER redeploy, verified before driving). Evidence chain:
  `.planning/2026-09-09-self-arc-19-subagent/map.md` (Loop findings, F-deploy-1).
- **The ext "bundle cache" does not exist** — `buildExtPackage`
  (`bun-apps/s2-agent-ext-devops/src/deploy/lib/ext-build.ts`) does
  `rmSync(opts.outDir, { recursive: true, force: true })` then an UNCONDITIONAL
  `bun build` on every deploy. A stale `ext.cjs` therefore cannot come from an ext
  cache object; it means the BUILD ITSELF READ STALE SOURCE BYTES — the bundler's
  module resolution (isolated-linker `node_modules/@repo/*` symlink farm) served
  different bytes than the worktree's real packages (learning #2's class: dangling or
  mis-pointed `@repo/*` symlinks survive `bun install` "no changes"), or the deploy's
  `bunAppsDir` resolution reached another tree.
- **The core cache hash already carries the F2 fix** — `computeCoreHash`
  (`deploy/lib/core-cache.ts`) hashes pi version, Bun.version, entry, flags, the
  `s2-agent/src` tree, AND `workspaceSrcDirs` (every `@repo/*` tree the bundle
  inlines; doc comment documents the 2026-09-06 stale-core crash). `ensureCachedCore`
  returns `cached:true` on `existsSync(<outRoot>/.cores/<hash>)`.
- **`.buns` is exonerated by code reading** — `computeBunHash` (`deploy/lib/bun-cache.ts`)
  keys ONLY runtime identity (bunVersion/platform/arch/libc); the entry is the bun
  BINARY, never app code. Out of scope.
- **Version-dir no-op** — `deploy/run.ts:834`
  `if (existsSync(target) && !opts.force) throw new DeployVersionExistsError(…)`; label
  = `<pkgVersion>+g<sha>`. Ruled FINE by the queue head (same sha ⇒ same content in a
  clean tree) — not reopened here.
- **The 107ms line does not discriminate the core mechanism**: a printed
  `Bundled N modules` proves SOME bun build ran (2556 is core-scale), but the core
  could equally have been cache-hit while the ext build read stale bytes, OR built
  fresh from stale-resolved sources. Pinning this is t01's investigation step, not an
  assumption.
- **F-steer-1 evidence (session receipt)**: steering a background child 15s in
  (mid-`sleep 90` tool call, steer toolCall 22:17:56Z) returned `steered:false` →
  "ran as a fresh turn"; the fresh turn never reached the child's output; the child
  completed and reported without the guidance ("had just gone idle" reading at
  22:19:01Z). Session:
  `~/.pi/agent/sessions/--Users-huangziyu-proj-video_generation__subagent--/2026-09-09T22-17-23-960Z_01a0883f-48f8-7c1d-8c70-2bf485f8f06e.jsonl`.
- **The live-agent state model has no tool phase** — `persistent-agent.ts:89`
  `LiveAgentStatus = "running" | "idle"`; `send()` (:208-226) maps running →
  `session.steer(text)` + `{steered:true}` immediate return, idle → `session.prompt`
  under a per-exchange timeout; `_status = "idle"` at exchange end (:288). Module
  header: "a send while running degrades to steer() by design". Arc-19's verdict:
  mid-flight detection covers MODEL exchanges only — during a long tool call the
  status read says "idle", so the steer fell into the prompt path and was lost.
- **The steer reply is two-way only** — `subagent-runs-tool.ts:349-373`: leverless
  runs → `"not steerable"` (:368); otherwise the reply branches on `r.steered`
  (:371-373) with no queued/tool-window outcome. The lever is wired only for named
  live agents (`child-dispatch.ts:82-86`, `:190`).
- **tui-drive home** — `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts` +
  `scripts/lib/tui-drive-lib.ts` (UI_VOCAB, boot gate, launcher provenance from
  arc-19 t01), tests `tests/tui-drive-vocab.test.ts` / `tests/tui-drive-hardening.test.ts`.
- **Devops gates** — `bun-apps/s2-agent-ext-devops/package.json` scripts:
  `check` = `tsc --noEmit`, `test` = `bun test`. Existing test homes for t01:
  `tests/core-cache.test.ts`, `tests/bun-cache.test.ts`, `tests/deploy-run.test.ts`,
  `tests/deploy-e2e.test.ts`.
- **Concurrent actors** — `../video_generation__memory` and `../video_generation__movie`
  are ACTIVE loop worktrees; untouched by this arc. This arc runs in the caller
  worktree on `self-arc-22` (already cut at `61688652`, verified).
- **Ledger** — `.planning/arc-ledger.json` entries stop at 21; claimProcedure: append
  ONE entry at branch time (status mirrors the map frontmatter); the wayfind guard
  (`bun-apps/s2-agent-ext-wayfind/src/arc-ledger.ts`, `tests/arc-ledger.test.ts`)
  fails CI on duplicate non-grandfathered `(series, number)`. Number 22 claimed by
  this branch's ledger edit.

## Scope decision

IN: t01 (deploy caches + pre-build link gate + post-deploy marker attestation in
verify-deploy-e2e + stale repro test — all inside `s2-agent-ext-devops`), t02
(third live-agent state + guaranteed queued delivery + honest 3-way steer reply in
`core-runtime`/`ext-subagent`, schema-cost delta generated and cited, tui-drive steer
drill scenario), t03 (redeploy + pre-drive grep-assert + deployed steer drill +
dispatch smoke; receipts under `output/self-arc22-*`), t04 (docs close-out PR).
OUT: reopening the version-dir no-op (ruled fine); any `.buns` change (exonerated);
send_message's named-agent steer path (arc-19 D6 boundary stands); pi-tui changes;
cross-OS tui-drive legs.

## Tickets

**Phase 1 — implementation (ONE PR: t01+t02, devops chain)**

- [ ] `tickets/01-deploy-stale-bundle-cache.md` — t01: pin the stale-serve mechanism
      (repro), key every cache on bundler-RESOLVED source content, stat-through
      `@repo/*` link integrity pre-build, grep-assert source-derived markers in every
      rebuilt bundle inside verify-deploy-e2e; stale repro test red-on-main
- [ ] `tickets/02-steer-tool-window.md` — t02: surface the tool-running state on the
      live agent, guarantee queued-turn drain after the current exchange, honest
      3-way steer reply; schema-cost delta cited; tui-drive steer drill scenario

**Phase 2 — deployed verification (after the implementation PR merges)**

- [ ] `tickets/03-deployed-verification.md` — t03: redeploy with t01 live, GREP-ASSERT
      the new symbols in the deployed bundles BEFORE driving, then
      `tui-drive --sh <deployed>` steer drill + dispatch smoke; receipts under
      `output/self-arc22-*`

**Phase 3 — close-out (separate docs PR)**

- [ ] `tickets/04-closeout.md` — t04: map Shipped-as + Loop findings, ledger
      `mergedPr`, reciprocal back-links, successor next-goal (strict v2)

## Decisions

- D1 (2026-09-10): t01 is TWO-LAYERED by design — (a) hash what the bundler RESOLVES
  (compute hash inputs through the same resolution `bun build` uses, so symlink
  staleness changes the hash or fails loudly), and (b) an artifact-side post-deploy
  guard that grep-asserts distinctive markers derived from the hashed sources in
  every rebuilt bundle (string literals survive minification — learning #1 applied
  mechanically). Reason: three candidate mechanisms remain (ext build read stale
  bytes through the link farm; `.cores` hash/resolution divergence; stale version
  dir at label) and the artifact-side guard closes ALL of them — it checks bytes,
  not labels. The label is not the content.
- D2 (2026-09-10): `.buns` stays untouched — its key is runtime identity only and it
  cannot serve stale app code (code-read this session). The repro test may assert the
  class stays closed only if it costs nothing.
- D3 (2026-09-10): the version-dir no-op logic stays as-is (queue-head ruling); the
  pre-build LINK-INTEGRITY GATE is the prophylaxis for its blind spot — stat through
  every `bun-apps/node_modules/@repo/*` symlink, fail the deploy loudly with the
  `ln -s ../../<pkg>` repair when dangling or mis-pointed (learning #2 mechanized).
- D4 (2026-09-10): steer-in-tool-window delivery is implemented at the LiveAgent seam
  — a third state (`tool`) on the live agent, and a text queue drained at the
  exchange-end idle transition, rather than racing `session.prompt` against an
  in-flight tool call (the receipt shows that race ends in a void). t02 first
  verifies whether pi's own session queue provably drains (use it if so); the
  LiveAgent-held queue is the fallback that makes the guarantee ours. The tool reply
  states exactly one of: steered-into-current-exchange / queued-after-current-tool /
  child-idle-ran-immediately (with reply snippet).
- D5 (2026-09-10): PR structure per directive — ONE implementation PR (t01+t02) via
  prepare-feature-branch → local-ci → merge-pr-after-ci; ONE docs close-out PR (t04).
  t03 is receipts-only in this worktree, no PR. Version-bump ONLY if
  `bun-apps/s2-agent/**` changes (t01 = ext-devops, t02 = ext-subagent +
  core-runtime ⇒ expect NO bump; state the check in the PR body).
- D6 (2026-09-10): model policy unchanged — planner/children `zai/glm-5.3`, never
  flash; receipt checks exclude flash BY NAME (shares self-arc-12 D5, narrowed as in
  arc-19 D9). `output/` is scratch; receipts never committed.
- D7 (2026-09-10): t02 touches tool descriptions (steer outcome vocabulary) — the PR
  body MUST cite the generated schema-cost delta
  (`bun bun-apps/s2-agent/src/cli.ts tools-metrics --schema-cost --json`).
- D8 (2026-09-10): number 22 claimed VIA the ledger (standing procedure since
  arc-21): entry appended on this branch with `status: "active"`; `mergedPr` filled
  at merge by t04; the wayfind guard enforces uniqueness.

## Frontier

`tickets/01-deploy-stale-bundle-cache.md` first: its investigation phase pins the
stale-serve mechanism, and every later artifact depends on deploy trustworthiness —
t02's deployed steer drill is meaningless if the redeploy can serve stale bundles
again, and t03's pre-drive grep-assert is exactly the manual form of t01's guard (the
ticket mechanizes it). t02 is independent of t01 in code but rides in the same PR
(D5); its drill lands in tui-drive now and is RECEIPTED in t03.

## Fog of war

- The exact F-deploy-1 mechanism (three candidates in D1's reason). The
  `Bundled 2556 modules in 107ms` line does not discriminate core-cache-hit from
  built-from-stale-source; t01's repro must, before the fix is believed.
- Whether the pi session API exposes tool-phase events (and a provably-draining
  queue) to core-runtime — D4's "use the session queue if provable" branch depends
  on it. `persistent-agent.ts` owns a lifetime subscription; the tool-call seam was
  not read this session.
- Marker-selection determinism for the attestation guard: the rule (e.g. k longest
  unique string literals per hashed source tree) must be stable across bun versions
  and pinned by its own unit test — a drifting marker set fails deploys spuriously.
- Whether the ext-side attestation should hash only the ext package's `src/` or also
  the `@repo/*` trees its bundle inlines (mirror `workspaceSrcDirs`); decide by what
  the ext bundler demonstrably inlines (Gate-1 externals list is the input).
- Deploy timing for t03 — irrelevant: t03 deploys explicitly (arc-19 D5 pattern).

## Cross-effort links

Builds-on: `2026-09-09-self-arc-19-subagent` (the queue head — F-deploy-1/F-steer-1
charted and receipted there; the steer verb, lever, and depth cap this arc hardens),
`2026-09-06-self-arc-12` (receipt discipline and the grep-the-artifact lineage this
arc mechanizes into verify-deploy-e2e), `2026-09-10-self-arc-21-receipt-validator`
(t03 receipts must stay re-gradeable from primary evidence).
Shares-decision-with: `2026-09-06-self-arc-12` D5 (glm-5.3-only model policy — D6).
Sibling-not-touched: self-arc-18 in `../video_generation__memory` and the
`../video_generation__movie` loop worktree (active, independent).
Reciprocal back-links are added to those maps at close-out (ticket 04).
