---
type: grilling
status: closed
blocked by: 03
---

# 06 — Cross-OS verification strategy

## Question

How is a Windows/Linux tree VERIFIED when the build host is a mac —
structural gates only (gates 1-5 on host, boot deferred), CI runners
(windows/linux) running `verify-deploy-e2e`, a manual operator checklist, or
deferred entirely to first real deployment?

## Notes for the resolver

- `verify-deploy-e2e-cli.ts` boots `./s2-agent.sh` with the tree's own
  `bin/bun` — a PE bun cannot boot on macOS, full stop. Linux x64 trees
  MIGHT boot via Docker/colima on this machine (unverified — check what's
  installed before proposing).
- The post-deploy auto-E2E contract (`deploy-cli.ts:63-77`) needs a
  platform-aware skip or a structural-only mode for non-host targets.
- Model-call probes depend on LM Studio reachability — irrelevant on CI
  runners; decide what the reduced probe set is off-host.

## Resolution (2026-08-27)

**Decision D8 (user-confirmed): GitHub Actions matrix is the cross-OS
verification channel — manual `workflow_dispatch`, ubuntu-latest +
windows-latest.** Each runner deploys for its OWN host target and the
post-deploy E2E runs against the host tree natively, exercising everything
the mac build host cannot: the sh launcher on linux, the .ps1/.cmd
launchers + PE bun on windows, t05's skipped boot gates, and t04's
deferred PowerShell friction — as REAL findings on first dispatch, not
projections.

### Measured before deciding (this machine, 2026-08-27)

- **CI inventory**: `.github/workflows/` = `full-repo-backup.yml` (active,
  ubuntu-latest) + `ci.yml.disabled` (7× ubuntu-latest, disabled). ZERO
  windows/linux test-runner precedent; remote is GitHub-only (no Gitea CI).
- **D7 channel end-to-end (first REAL network path)**: `deploy-cli
  --target linux-x64-glibc` and `--target win32-x64` from this darwin host
  both fetched their bun from the real GitHub release (80.7 MB ELF x86-64 /
  88.8 MB bun.exe, SHASUMS256-verified), packed full trees, repointed
  per-target `current`. The acquisition half of the pipeline is now
  measured, not fixture-backed.
- **E2E recipe launcher hardcoding**: `deploy-e2e-recipe.ts` spawned
  `./s2-agent.sh` at all 4 probe sites + the presence gate — a windows
  runner would have failed fast on a launcher the tree doesn't boot. Fixed
  in this ticket (below).

### Landed

- **`.github/workflows/crossos-deploy-verify.yml`** — manual dispatch;
  matrix ubuntu-latest + windows-latest; checkout + setup-bun (1.4.0,
  runner-side only) + `bun install --cwd bun-apps` + deploy-cli host deploy
  (out: `runner.temp`); deploy-report uploaded as artifact (always()).
  macos EXCLUDED deliberately (10× private-repo billing; darwin-arm64 is
  verified on the build host by every local deploy). Not a per-PR gate.
- **`deploy-e2e-recipe.ts`** — `launcherInvocation(platform)`: win32 trees
  boot `cmd /c s2-agent.cmd` (a .cmd cannot be exec'd directly); everything
  else `./s2-agent.sh` unchanged (pre-t05 trees without runtime facts → sh,
  byte-identical behavior). All 4 spawn sites + the presence failFast now
  derive from it; `DeployJson` gains optional `runtime`.
- **`deploy-cli.ts`** — `S2_AGENT_E2E_SKIP_MODEL_CALL=1` env override (both
  call sites): provider-less runners skip the model-call probe explicitly
  instead of leaning on the connect-refused heuristic.
- **Tests**: `launcherInvocation` pure matrix; a win32 fixture tree boots
  through `cmd /c` at every probe (command + prefix recorded); a win32 tree
  without `s2-agent.cmd` fails fast naming the cmd launcher. devops
  canonical `bun run test` 938 pass / 0 fail (check incl. tsc clean).

### Review round (harness `/code-review high`, 2026-08-27 — 8 findings, ALL addressed)

- **spawn.ts win32 group-kill** (top severity, two finders converged):
  `kill(-pid)` throws on Windows and the child-only fallback orphans
  grandchildren holding stdio — a wedged probe would hang to the job
  timeout without recording FAIL. Win32 timeout path now uses
  `taskkill /T /F` (tree kill).
- **scanForeignPaths POSIX-only**: drive-letter paths
  (`C:\Users\runneradmin\…`) never matched the leading-`/` anchor, so a
  windows build host's Gate 5b silently passed baked paths. Regex now
  anchors drive-letters too; both sides separator-normalized (tests:
  backslash + forward-slash spellings, in-tree allow, URL/relative
  non-match).
- **PROVIDER_RE missed connection refusal**: "Unable to connect …
  ECONNREFUSED" (no provider word) FAILED healthy trees on provider-less
  runners — extended with econnrefused/connection refused/unable to
  connect/fetch failed (classifyRun shared by oneshot-smoke; test added).
- **One opt-out surface**: verify-deploy-e2e-cli now honors
  S2_AGENT_E2E_SKIP_MODEL_CALL too (was flag-only while deploy-cli was
  env-only); skip note names flag AND env; misleading deploy-cli comment
  fixed.
- **win32 presence gate also checks s2-agent.ps1** (the .cmd's real
  target) so its absence fails fast naming the file (test added).
- **Workflow `runner.temp` quoted** (self-hosted runners with spaces).
- **Docs de-sh'd**: recipe probe docs, deploy-cli comment, verify CLI
  usage text now say "the deployed launcher" with the win32 spelling.

### Honest gaps

- **First dispatch not yet run** — the workflow is landed but untriggered;
  the first windows-latest run IS the measurement of t04's deferred
  frictions (execution policy, TUI console inheritance, .cmd spawn twin).
  Expect iteration: the deploy pipeline itself (paths, symlinks, bash-isms)
  has never executed on windows and may surface portability findings.
- Emulation (Docker/colima linux on mac) rejected without re-measuring: the
  Actions channel subsumes it at better fidelity; revisit only if dispatch
  cadence becomes a cost problem.
- t04's ticket records its deferred friction list — close-out references
  stay there; this ticket owns the CHANNEL.
