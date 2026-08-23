# Ticket 03 — gates-and-e2e

status: closed (2026-08-23)

blocked-by: `01-core-bundle-seam.md`, `02-ship-bun-and-launcher.md`.

## Resolution (2026-08-23)

- Gates 3/6 + `extListOf` boot `<tree>/bin/bun <tree>/s2-agent.js` (never the
  CLI's own bun); Gate 6 keeps its different-absolute-path clone semantics,
  the copied `bin/bun` relocating trivially.
- Gate 5b scans BOTH `s2-agent.js` (plain text) and `bin/bun`; the pristine
  bun produced ZERO foreign hits on the real deploy (its embedded build
  strings are CI-runner paths, not under this machine's `$HOME` or repo), so
  the allowlist table gained no new rows — the existing
  `~/.bun/install/cache/` row stays as documented defense with a reworded,
  bun-accurate reason.
- `verify-deploy-e2e` / `deploy-cli` boot `<outRoot>/current/s2-agent.sh`
  (run.sh = deprecated shim, probed only implicitly); help/docs strings
  updated (recipe header, CLI usage, SKILL.md, app-name/deploy-report copy).
- Compiled remnant DELETED: mode.ts "binary" mode (`$bunfs` arms) and its
  consumers (doctor DeployMode/classifyMode/realContext/smoke exeDirect,
  ext-doctor binaryMode, skip-update-check binary gate, run-dir resolve's
  binary branch), the whole embedded-assets mechanism (extract-embedded-assets
  patch + generate-embedded-assets codegen + devops codegen.ts +
  src/generated/), and the now-inert `binarySkills` registry/manifest key
  (5 registry lines, emitter field, manifest regenerated). `grep -- --compile
  bun-apps/s2-agent-ext-devops/src` → clean. scrub-inherited-package-dir.ts
  KEPT: retention still holds compiled dirs whose frozen binaries leak
  PI_PACKAGE_DIR (measured: `0.2.5+gb69d3e3/s2-agent --ext-list` → 17/17).
- **Live proof (real outRoot `~/proj/dist/s2-agent-sh`)**: deploy
  `0.2.5+gb7b7719` — six gates green, `current` flipped, core 6,182,446 B
  (fresh build, not cached), runtime bun 1.4.0/darwin/arm64 63,558,256 B,
  retention pruned `0.2.2+g52abe6d` + collected the last 71,175,794 B compiled
  `.cores` entry. Auto post-deploy E2E: boot 5.6 s / ext-load 17 ext / model-
  call 121.6 s — all pass (contention warning: qwen 27b + gemma 12b resident).
  Standalone `verify-deploy-e2e-cli.ts` → exit 0 (boot 5.7 s / ext-load 0.5 s
  / model-call 244.2 s, all pass). Old compiled version dirs boot untouched.
  NOTE: the version label carries the pre-change HEAD sha (b7b7719) because
  the tree was deployed from the working tree pre-commit; the merged code
  gets its own version dir on the next deploy (0.2.6 line).

## Goal

The proof layer speaks the new shape end to end: Gates 3/5b/6, `deploy-cli`'s boot, and
`verify-deploy-e2e` all spawn `bin/bun s2-agent.js` (via the launcher or directly), and a
REAL deploy to the real outRoot passes everything including post-deploy E2E. This ticket
also deletes the compiled-core remnant once green.

## Steps

1. **`run.ts` `extListOf` / `verifyDualState` (Gate 3) / `verifyRelocatable` (Gate 6)** —
   spawn `[<tree>/bin/bun, <tree>/s2-agent.js, "--ext-list"]`. Gate 6 keeps its
   different-absolute-path clone semantics; the copied `bin/bun` relocates trivially —
   the assertion value shifts to the bundle + assets resolving from the new path.
2. **Gate 5b (`offline-gate.ts` `scanBinaryForeignPaths`)** — scan BOTH `s2-agent.js`
   (plain text — foreign build paths now readable, strictly stronger than the binary
   heuristic) and `bin/bun` (a binary we did not build: expect bun-internal build
   strings; add ONLY justified rows to the allowlist table, each with its why — never a
   blanket skip of the file).
3. **`verify-deploy-e2e-cli.ts` + `deploy-cli.ts`** — boot paths go through
   `<outRoot>/current/s2-agent.sh` (which now means `bin/bun` + bundle); update the
   help/docs strings that say "run.sh". The E2E ladder (boot + ext-load + model call,
   300 s cap, LM-Studio contention precheck — #1850) is unchanged in substance.
4. **Docs touch-points** — SKILL/README/help text in `s2-agent-ext-devops` that describe
   the compiled binary (`src/deploy/lib/app-name.ts` header comment, deploy-report copy)
   updated to the bundle + `bin/bun` shape; keep it minimal per repo docs policy.
5. **Delete the compiled remnant** — `compile()` `--compile` branch, execPath-mode dead
   code from ticket 01's mode branch (the `$bunfs` arm), `--minify`-only flag lists:
   after the first green real deploy, the compiled mode has no callers left.
6. **Live proof (done-gate)** — `deploy-cli.ts` against the real outRoot
   (`~/proj/dist/s2-agent-sh`): all six gates pass, `current` flips, auto post-deploy
   E2E green, and the OLD compiled version dirs still boot (retention keeps them; they
   are untouched by this change). Record version + report numbers in the ticket
   resolution.

## Done-when

- Real outRoot deploy green end to end; `~/proj/dist/s2-agent-sh/current/s2-agent.sh`
  boots the full extension set and `verify-deploy-e2e-cli.ts` exits 0.
- `grep -rn "build --compile\|--compile" bun-apps/s2-agent-ext-devops/src` returns
  nothing (outside tests/fixtures asserting its absence).
- Repo docs describe the new layout; `bun run test` green in s2-agent-ext-devops (and
  any package whose gates touched, per local_ci resolution).
