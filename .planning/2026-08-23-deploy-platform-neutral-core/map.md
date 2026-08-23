---
effort: 2026-08-23-deploy-platform-neutral-core
created: 2026-08-23
last: 2026-08-23
status: done
---
# deploy-platform-neutral-core — replace the compiled core with a bun-run ESM bundle + shipped bun

## Destination

The s2-agent-sh deploy's core ships as a **platform-neutral ESM bundle** (`s2-agent.js`, built
by `bun build --target=bun`) plus a **copy of the build machine's bun** at `bin/bun`, launched
by a renamed `s2-agent.sh` that execs `<deployDir>/bin/bun <deployDir>/s2-agent.js`. The
compiled `Mach-O s2-agent` binary and its `bun build --compile` step are gone; all six deploy
gates, the core cache, and `verify-deploy-e2e` pass against the new shape; a cross-platform
target swaps in a platform-appropriate bun without rebuilding anything else.

## Context (measured 2026-08-23 on this machine, bun 1.4.0, spike tree `/tmp/s2agent-cjs-spike/`)

- **Current core**: `~/proj/dist/s2-agent-sh/current/s2-agent` is a 71,175,794 B Mach-O
  arm64 binary produced by `bun build --compile src/cli-sh.ts --minify`
  (`s2-agent-ext-devops/src/deploy/run.ts:148`). Total dist ≈ core + ext/ + report.
- **ESM bundle builds and boots.** `bun build --target=bun --minify` over the same entry:
  2,542 modules, 126 ms, **6,183,088 B** `s2-agent.js`. Booted with
  `PI_AGENT_SH_EXT_DIR=<current deploy>/ext`: `--ext-list` reports **17/17 extensions
  loaded, 0 skipped** — identical set to the compiled binary's current deploy.
- **CJS is out on a technicality that is actually a finding**: `--format=cjs` fails to parse
  — `cli-sh.ts:88` has top-level `await applyPatches()`, illegal in CJS. Bun runs ESM
  natively, so the core ships as ESM `.js`; the `ext/<name>/ext.cjs` bundles are a separate
  mechanism (pi's extension loader) and stay CJS untouched.
- **The one real seam break**: `src/cli-sh.ts:39` anchors ext discovery on
  `dirname(process.execPath)`. Under `bun s2-agent.js`, execPath is bun itself — measured:
  bare boot reported `"extRoot": "/Users/huangziyu/.bun/bin/ext"` (zero extensions,
  silent). The existing `PI_AGENT_SH_EXT_DIR` override rescued the spike.
- **Self-location survives bundling.** Probe bundled with the same flags:
  `import.meta.dir` = the output file's directory, `process.argv[1]` = the bundle path,
  `process.execPath` = bun. So a bundle-mode branch anchoring on `import.meta.dir` works.
- **packageDir resolution already works.** With the deploy's `package.json` copied next to
  the bundle, `bun s2-agent.js --version` prints `0.2.3+g06dbb2e` — pi reads version /
  `piConfig` from beside the bundle in bun-run mode (no code change needed there).
- **`doctor` misclassifies the bundle.** `bun s2-agent.js doctor --json` reports
  `"mode": "source"` and FAILS the entry check (`not found: …/cli.ts`) — `doctor.ts`'s
  coarse binary/source split has no bucket for "bundled js run by bun"
  (`doctor.ts:517,524`).
- **Embedded assets become sidecar files — and then stop mattering.** With the embed-mode
  manifest generated (19 files), the same build emits `cli-sh.js` + **19 hashed asset
  files**, dir total **6.9 MB**, boots 17/17. But a second probe
  (`/tmp/s2agent-cjs-spike/dist-layout/pkgdir-probe.js`) proved something better: bundled
  pi resolves `getPackageDir()` by walking up from the bundle to the deploy
  `package.json`, and then looks for assets at its **Node layout** —
  `<deployDir>/dist/modes/interactive/{theme,assets}` and
  `<deployDir>/dist/core/export-html` — all three `existsSync: true` in a simulated
  deploy tree with NO env redirect. So the deploy copies those three pi dirs into the
  version dir, the bundle builds against the **empty** manifest (single 6.18 MB file, no
  sidecars), and the whole `~/.pi/agent/embedded-assets/` extraction mechanism is never
  triggered in bundle mode (it dies with the compiled mode in ticket 03).
- **Shipped bun**: `process.execPath` (bun 1.4.0) is 63,558,256 B. New core total
  6.2 + 63.5 ≈ **70 MB — within 1 MB of today's 71 MB compiled core**.
- **This shape existed before.** The consolidation spec
  (`.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`) retired
  `--standalone` = "`--bundle` + a copied `bun` binary". The retirement reason was four
  drifting pipelines converging into one — not a defect of bundle+shipped-bun. This effort
  changes the core artifact INSIDE the one remaining pipeline; it does not reopen the
  four-mode question.

## Tickets

Phase 1 — the seam
- `tickets/01-core-bundle-seam.md` — task, **closed** (2026-08-23) — bundle-mode
  self-anchor in `cli-sh.ts`, doctor's third mode, `buildCore` emits the ESM
  bundle, pi assets copied at Node layout (scope revised mid-ticket: no
  sidecars, no multi-file cache — see D5/D6)

Phase 2 — runtime shipping
- `tickets/02-ship-bun-and-launcher.md` — task, **closed** (2026-08-23) — `.buns`
  content cache, `bin/bun` hardlink, `s2-agent.sh` launcher + run.sh shim;
  full-chain e2e verified (shim → launcher → shipped bun → bundle, 17/17)

Phase 3 — proof
- `tickets/03-gates-and-e2e.md` — task, **closed** (2026-08-23) — Gates 3/5b/6
  + e2e boot the new shape (5b scans both artifacts; pristine bin/bun
  produced zero foreign hits); compiled remnant + embedded-assets mechanism +
  `binarySkills` key deleted; real-outRoot deploy `0.2.5+gb7b7719` green end
  to end incl. post-deploy E2E and old-compiled-dirs-still-boot

Phase 4 — operator follow-up (same day)
- `tickets/04-launcher-path-self-containment.md` — task, **closed** (2026-08-23) —
  launcher prepends the resolved bun's dir to PATH so session-spawned children
  (`Bun.spawn(["bun",…])`, shells, self-heal) resolve the deploy's own bun,
  never a system one; `S2_AGENT_BUN` override stays honored by PATH too
- `tickets/05-drop-run-sh-shim.md` — task, **closed** (2026-08-23) —
  operator ended the shim's grace period the same day; `RUN_SH` deleted from
  staging, e2e asserts absence, probes boot `s2-agent.sh` directly; repo-side
  dev `bun-apps/s2-agent/run.sh` untouched

## Decisions

Recorded with rationale in `spec.md` §3 (D1–D6). The load-bearing three:

- **D1 — ESM `.js`, not `.cjs`.** Top-level await in the entry makes CJS unparseable, and
  bun runs ESM natively — nothing is gained by fighting the format.
- **D2 — self-anchor beats env-var rescue.** `cli-sh.ts` grows a bundle-mode branch
  (`import.meta.dir` when not compiled) so `bun s2-agent.js` boots correctly WITHOUT the
  launcher; measuring confirmed `import.meta.dir` survives bundling. `PI_AGENT_SH_EXT_DIR`
  stays as the operator override.
- **D5/D6 revised 2026-08-23 (probe-driven)** — the core stays ONE file (`--outfile`,
  empty asset manifest; `.cores` single-file shape unchanged, flags only) and assets ship
  as plain copies at pi's Node layout (`dist/modes/interactive/{theme,assets}`,
  `dist/core/export-html`) — no sidecars, no extraction, no
  `~/.pi/agent/embedded-assets/` in bundle mode. See spec §3 D5/D6 for the probe.
- **D3 — the platform-neutral claim is scoped to the bundle.** The shipped `bin/bun` is
  per-platform by design (copied from `process.execPath`); cross-platform use = swap that
  one file for the target platform's bun of the same version. No cross-compile, no
  multi-platform matrix in this effort.

## Frontier

None — the effort is closed (2026-08-23). All three tickets merged; the
deployed dist at `~/proj/dist/s2-agent-sh/current` is a bun-run ESM bundle +
shipped `bin/bun` + `s2-agent.sh` launcher, verified by a live deploy with
post-deploy E2E green and old compiled version dirs still booting. Tickets 04
(launcher PATH self-containment) and 05 (run.sh shim dropped — grace period
ended by the operator the same day) also closed. Remaining natural follow-up:
reword the historical `--compile`/`$bunfs` comments in s2-agent/src on their
next touch (they document still-true constraints).

## Fog of war

- **merge_pr_after_local_ci env-only s2-agent/test failure (2026-08-23, ticket 02).**
  Both in-merge local_ci runs failed `s2-agent/test` with a tail-only diagnostic
  ("s2-agent cli 0.2.5 ⏎ s2-agent cli 0.2.5" — no failing-test name, no summary
  lines, i.e. output consistent with a killed run), while the SAME sha passed
  `local-ci-cli --concurrency 1` AND a direct `runLocalCi` call with the merge's
  exact params. Merged on `--assume-ci-green` with both green receipts. Unresolved:
  what the merge's recording-spawn environment changes; if it recurs on ticket 03,
  instrument the step runner (capture full step output, not the tail).
- **Upstream mode detection beyond doctor.** Only `doctor` was probed for
  bun-run-bundle confusion; pi's own internals may branch on compiled-vs-source elsewhere
  (e.g. `scrub-inherited-package-dir.ts` assumptions). Ticket 01 sweeps for
  `execPath`/`$bunfs` anchors across `s2-agent/src`.
- **Gate 5b on a pristine bun.** RESOLVED (ticket 03): the real deploy's scan of
  `bin/bun` produced ZERO foreign hits — bun's embedded build strings are CI-runner
  paths, not under this machine's `$HOME` or the repo. No new allowlist rows needed.
- **Bun-version drift on swapped-platform runs.** Supported contract is same-`Bun.version`
  (already part of the core hash). Unbounded forward-compat is explicitly out of scope.
- **`s2-agent.sh` on Linux assumes bash** — same assumption today's `run.sh` makes; noted,
  not solved here.

## Cross-effort links

- **Builds-on**: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`
  (flat spec — no map of its own) and `.planning/2026-08-20-devops-hardening` — the single
  pipeline, six-gate structure, `.cores` cache and Gate 6 relocation smoke this effort
  modifies are theirs. Replacing the compiled core does not reopen their four-mode
  retirement; the `--standalone` row of their legacy table is the ancestor of this shape.
- **Shares-decision-with**: `.planning/specs/2026-08-19-pi-agent-sh-deploy-design.md` —
  its execPath/packageDir conventions (`package.json` branding beside the artifact,
  dashed `S2-AGENT_CODING_AGENT_DIR` via `env`) carry over verbatim into `s2-agent.sh`.
