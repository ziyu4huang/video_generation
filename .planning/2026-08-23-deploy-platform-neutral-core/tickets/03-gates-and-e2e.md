# Ticket 03 — gates-and-e2e

status: open

blocked-by: `01-core-bundle-seam.md`, `02-ship-bun-and-launcher.md`.

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
