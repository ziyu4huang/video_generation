---
effort: 2026-08-26-s2agent-crossos-deploy
created: 2026-08-26
last: 2026-08-27 (tickets 01–07 closed — D8 landed: GH Actions cross-OS verify channel + platform-aware E2E launcher + REAL D7 network path measured; frontier = 08)
status: active
---

# s2-agent cross-OS deploy — mac / linux / windows

## Destination

The s2-agent-sh deploy pipeline packs runnable trees for macOS, Linux, AND
Windows from one build: the same platform-neutral `s2-agent.js` bundle, a
per-platform vendored `bin/bun`, and per-OS launchers — including a PowerShell
`s2-agent.ps1` for Windows. A deploy produces verified trees for the chosen
target matrix; nothing on the target machine is required except the OS
(no npm, no bun install). Deploy-path simplifications (dead `--compile`
compat code, vendor-closure platform pass-through) fold in here.

## Context

MEASURED 2026-08-26 on this machine (recon sweep, file:line cited in
tickets; sibling effort merge-base `a57b6d38`):

- **The architectural lift is already done** (2026-08-23-deploy-platform-neutral-core,
  PRs #1860/#1863/#1866/#1867/#1868): core = `bun build --target=bun
  --minify` ESM bundle (~6.2 MB, platform-neutral) + shipped `bin/bun`
  (~63.5 MB, content-cached `<outRoot>/.buns/<hash>`, hash folds
  Bun.version+platform+arch) + bash launcher. The swap contract is documented
  at `deploy/run.ts:236-238`: relocate to another OS/arch = replace `bin/bun`
  with that platform's same-version bun. Compiled mode (`bun build
  --compile`) is DELIBERATELY RETIRED — do not resurrect it (prior decision).
- **Windows blockers are concentrated** (recon §3/§6): both launchers are
  bash (`set -euo pipefail`, `BASH_SOURCE`); the deployed launcher uses
  `env(1)` for the dashed `S2-AGENT_CODING_AGENT_DIR` var
  (`deploy/run.ts:219,251-257,282`), colon-PATH prepend (`:280`), `$HOME`
  fallback (`:257`), `chmod 0o755` (`:550`), and the `current` symlink
  (`version.ts:38-50`). ZERO .cmd/.ps1 exists for s2-agent today.
- **Native surface is clean**: SQLite = `bun:sqlite` builtin everywhere
  (hermes `sqlite-backend.ts:92`); no node-gyp/better-sqlite3; sharp only in
  the DISABLED hyperframes ext; playwright-core is an external that degrades.
- **Vendor filtering exists but is build-machine-bound**:
  `vendor-closure.ts:183` defaults `platform = process.platform` — cross-OS
  vendoring needs the target platform passed in (os/cpu/libc match logic
  already there, `:151-172`; detectLibc glibc/musl, `:111-121`).
- **MLX-domain exts are darwin-by-nature** (movie-director, flux2/krea2/ltx
  swift runners spawn "bash" + MPS) — a Windows tree carrying them is dead
  weight at best, boot-failing at worst.
- **bun-via-npm is viable and official** (research, 2026-08-26): `npm
  install -g bun` works on all three OSes (official since Bun 1.1); the npm
  `bun` package fetches per-platform binaries (@oven/* platform packages).
  Relevant ONLY as the build-side acquisition channel for per-platform bun
  binaries — target machines never need npm (tree ships `bin/bun`).
- **Post-deploy E2E assumes POSIX**: `verify-deploy-e2e-cli.ts` spawns
  `./s2-agent.sh` directly (`deploy-e2e-recipe.ts:412/427/437`) — a Windows
  tree cannot be boot-verified on a mac build host.

## Tickets

### Phase 1 — target matrix + acquisition (the shape decisions)
- [01] Target matrix + ext-set policy — closed 2026-08-26 (matrix v1 = darwin-arm64 + linux-x64-glibc + win32-x64; ext policy = per-platform filtering, registry gains a platform dimension)
- [02] Per-platform bun acquisition channel — closed 2026-08-26 (research, pre-fired at chart time; answer in ticket)

### Phase 2 — launcher + tree layout (the build work)
- [03] Packaging topology — closed 2026-08-27 (per-target subroots `<outRoot>/<target>/<version>/` + per-target `current`, `--target` flag default host; bun via GitHub release + SHASUMS256 — D6/D7)
- [04] PowerShell launcher `s2-agent.ps1` (+ entry shim) — closed 2026-08-27 (`.ps1` twin + `.cmd` Bypass shim shipped in every tree; real-Windows friction DEFERRED to 06 with blockers named: no Windows host, no CI windows runner)
- [05] Windows tree-layout compat (PATH/env/junction/exec-perms) — closed 2026-08-27 (D6/D7 pipeline landed: `--target` at CLI+tool surfaces, per-target subroots w/ shared caches, `acquireBunBinary` GitHub+SHASUMS256 → `ensureCachedBunFrom`, vendor target pass-through, boot gates skip w/ t06 note; tree-side mechanics classified in ticket; D5 → ticket 08)

### Phase 3 — verification + simplification fold-in
- [06] Cross-OS verification strategy (E2E on mac host vs CI runners) — closed 2026-08-27 (D8: GH Actions matrix channel landed — crossos-deploy-verify.yml, manual dispatch, ubuntu+windows; E2E launcher platform-aware; S2_AGENT_E2E_SKIP_MODEL_CALL; first dispatch pending = the real windows measurement)
- [07] Dead `--compile` compat-code cleanup on the deploy path — closed 2026-08-27 (every behavioral --compile branch deleted across core-runtime/superpowers + comment-only rewording in archify/ultracode; historical sites kept WITH citation — receipts in ticket)
- [08] Per-platform ext filtering (D5 build-out) — open (task; spawned from 05 — unblocked now that t06's channel exists)

**Execution order:** 01 → 02 → 03 → 04 → 05 → 07 → 06 → 08 (01–07 closed; 08 = the last ticket)

## Decisions

- **D1 — One map, destination = 3-OS deploy** (user, 2026-08-26): broad
  monorepo weight-reduction (flux2/krea2/ltx triplet scripts, tsx devDeps,
  empty husk dir, gate-script normalization) is OUT of this effort — it gets
  its own upkeep effort later; only deploy-path simplification folds in.
- **D2 — Compiled mode stays dead** (inherited, 2026-08-23 #1866): the 3-OS
  pack extends bundle+shipped-bun, never `bun build --compile` per-platform
  executables. Reopening this is a new decision with new evidence, not a
  default.
- **D3 — Target machines install nothing** (inherited + reaffirmed): the
  tree ships `bin/bun`; npm is at most a build-side channel. Gate 5's
  offline posture is untouched on the target side.
- **D4 — Matrix v1: darwin-arm64 + linux-x64-glibc + win32-x64** (user,
  2026-08-26, ticket 01): arm64 variants and musl stay fog until a concrete
  need surfaces.
- **D5 — Per-platform ext filtering** (user, 2026-08-26, ticket 01):
  non-darwin trees drop darwin-by-nature exts; registry gains a platform
  dimension; Gate 3 verifies per-tree expected counts.
- **D6 — Per-target subroots** (user, 2026-08-27, ticket 03): one deploy
  invocation → one complete immutable tree per `<outRoot>/<target>/<version>/`
  with a per-target `current`; caches (`.cores`/`.buns`) stay shared at the
  outRoot top level. Rejected: suffix version dirs (same semantics, larger
  change surface) and canonical-tree+swap (cannot express D5, no gate
  protection — swap stays an emergency escape hatch only).
- **D7 — Bun acquisition via GitHub release** (user, 2026-08-27, ticket 03,
  closes 02's ride-along): tag `bun-v<Bun.version>` per-target artifacts +
  official SHASUMS256, landing in `.buns/<hash>` under the same
  parameterized hash (`computeBunHash`). Build-side only (D3). npm `@oven/*`
  extraction rejected: depends on wrapper-internal tarball layout. Measured
  end-to-end against real github.com 2026-08-27 (ticket 06): linux + win32
  cross-deploys from a darwin host both fetched + verified their bun.
- **D8 — Cross-OS verification = GH Actions matrix, manual dispatch** (user,
  2026-08-27, ticket 06): `crossos-deploy-verify.yml`, ubuntu-latest +
  windows-latest, each runner deploys its OWN host target so boot gates +
  E2E run natively. macos excluded (10× private-repo billing; darwin is
  verified on the build host every deploy). Rejected: real box (none
  available — t04 measured), emulation (subsumed at worse fidelity).
  Model-call probe off on runners (`S2_AGENT_E2E_SKIP_MODEL_CALL=1`).

## Frontier

**Ticket 08 (per-platform ext filtering, D5 build-out)** — the last ticket.
The registry (s2-agent package) gains a platform dimension so non-darwin
trees drop darwin-by-nature exts (movie-director, flux2/krea2/ltx swift
runners); Gate 3 verifies per-tree expected counts. Now unblocked: t06's
channel can boot the filtered trees on native runners. First dispatch of
`crossos-deploy-verify` (windows) is the standing follow-through — expect
portability findings to iterate there.

## Fog of war

- CI runner reality: does this repo's CI (fast-lane, LM-Studio-out) have any
  windows/linux runner precedent? Unverified — becomes checkable once ticket
  06 sharpens.
- Windows arm64: bun ships it, but no user need stated — stays fog until the
  matrix (01) asks.
- Linux musl variant: detectLibc exists; whether musl trees are wanted is a
  01 sub-question.
- PowerShell execution-policy friction (.ps1 double-click blocked by
  default) — felt in ticket 04's prototype, not decidable now.
- Whether `completions.ts` should grow a PowerShell completion generator —
  adjacent, not blocking; park unless the launcher work surfaces demand.

## Cross-effort links

Builds-on: 2026-08-23-deploy-platform-neutral-core — this effort is the
documented cross-platform swap contract (run.ts:236-238) finally exercised;
D2/D3 above inherit that effort's decisions verbatim.
