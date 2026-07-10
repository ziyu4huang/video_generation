# pi-agent — TODO

Open enhancement candidates for the pi-agent package. The enhancement arc
shipped 11 PRs (#169–#186); the items below are what was queued but not yet
done, ordered by leverage. Each entry has enough detail to resume without
re-investigation.

## Shipped in this arc (for context)

- #169 args.ts numeric fail-fast · #170 PI_THINKING validation · #171 default-model-env patch
- #172 bundle e2e + multi-effort run-test.sh · #177 bundle-based deploy + banner
- #181 `--portable` FULL-bundle deploy · #182 `doctor` self-check
- #184 doctor e2e coverage + **critical fix**: cli.ts re-slice argv after patches (#182 had moved `process.argv.slice(2)` above `applyPatches()`, silently dropping every run-dir extension across all modes — see memory `pi-agent-cli-slice-before-patch-drops-splice`)
- #185 `doctor --smoke` — runtime probe that catches the silent-no-op class
- #186 `doctor --smoke` e2e across all 4 deploy modes
- `doctor --fix` — auto-remediate: runs `bun install` in a `--portable`/`--release`
  deploy when `checkHostDeps` FAILs, then re-checks (self-healing independent
  deploy). Same pure-plan + imperative-apply + spawn-seam shape as `--smoke`;
  `runChecks` stays pure. Bundle (THIN) stays hint-only; source/binary n/a.

## Open

### 1. lazy `-e <alias>` e2e  *(highest leverage — same risk class as the #182 bug, untested)*

`run-dir/resolve.ts` `rewriteArgvLazyExtensions()` rewrites `-e <alias>` (e.g.
`-e workflow`, `-e flux2`) to the resolved absolute path by mutating
`process.argv` — the SAME splice mechanism that broke twice in #182/#184. It
has unit coverage (`run-dir/resolve.test.ts`: `isAlias`, resolve) but **no e2e**
that runs an alias through the real bundle and proves the extension loads.

**Why it's the gap:** the eager `-e` path is now guarded by both the
extension-loading e2e AND `doctor --smoke`. The lazy alias path is guarded by
neither — a regression here (alias passed literally → pi tries to load "flux2"
as a source → silent failure) would be invisible.

**Scope (SOURCE mode only):** lazy aliases resolve to `bun-apps/<pkg>/...`
source paths, so they're a repo-present feature. A default bundle deploy does
NOT copy those source dirs, so `-e flux2` correctly does NOT work there — don't
add a deploy-mode case for it (it would be a false failure).

**How to implement (resumed investigation):**
- The alias factories are cheap at load time: `pi-agent-ext-flux2/extensions/pi-flux2.ts`
  registers a single `flux2` tool (just `pi.registerTool`, no `session_start`
  heavy work); `pi-agent-ext-workflow/extensions/workflow.ts` likewise. So a
  `session_start` probe that `process.exit()`s before the model call is fine.
- Reuse the existing probe pattern: run `bun src/cli.ts -e flux2 -e <probe> -p hi`,
  marker = `<repo>/bun-apps/pi-agent-ext-flux2`; assert `matched > 0` (and/or
  `flux2` tool present). A control run WITHOUT `-e flux2` should give `matched=0`
  (flux2 is lazy, not in the eager manifest) — proves the opt-in is what loads it.
- Add to `src/__tests__/e2e-extensions.test.ts` SOURCE describe, gated on the
  existing `PI_AGENT_E2E`/`PI_AGENT_E2E_DEPLOY` flags. `runScenario` already
  takes an arbitrary `cmd` string[], so `-e flux2` slots straight in.

### 2. Patch unit-coverage gaps

`src/patches/load-run-dir-resources.ts`, `set-package-dir.ts`, and
`skip-update-check.ts` have no dedicated `.test.ts` (only `default-model-env`
and `index` do). Lower ROI — these are thin and exercised indirectly by the
patch e2e + `doctor --smoke` — but a focused unit per patch would pin each
patch's env gate + effect.

## Not pi-agent (next-arc candidates, when this arc is resumed or closed)

- `pi-agent-cli` deep audit (sessions/shared.ts, args.ts beyond numeric)
- mlx pipeline hardening / the standing self-improve arc
