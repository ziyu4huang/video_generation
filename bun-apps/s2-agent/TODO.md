# s2-agent — TODO

Open enhancement candidates for the s2-agent package. The enhancement arc
shipped 11 PRs (#169–#186); the items below are what was queued but not yet
done, ordered by leverage. Each entry has enough detail to resume without
re-investigation.

## Shipped in this arc (for context)

- #169 args.ts numeric fail-fast · #170 PI_THINKING validation · #171 default-model-env patch
- #172 bundle e2e + multi-effort run-test.sh · #177 bundle-based deploy + banner
- #181 `--portable` FULL-bundle deploy · #182 `doctor` self-check
- #184 doctor e2e coverage + **critical fix**: cli.ts re-slice argv after patches (#182 had moved `process.argv.slice(2)` above `applyPatches()`, silently dropping every run-dir extension across all modes — see memory `s2-agent-cli-slice-before-patch-drops-splice`)
- #185 `doctor --smoke` — runtime probe that catches the silent-no-op class
- #186 `doctor --smoke` e2e across all 4 deploy modes
- `doctor --fix` — REMOVED (gated on deploy modes nothing produces; `bun install`
  cannot repair a snapshot). Re-adding needs an action that works on a build
  artifact, not a package manager pointed at one.

## Open

### 0. retire the `portable` / `release` layout branches in the launcher  ✅ DONE (2026-08-20)

Both consumers were already retired upstream: `run.sh` detects only
s2-agent.js (bundle) / src/cli.ts (source) with an explicit historical note,
and `run-dir/resolve.ts`'s `RunDirLayoutMode` is `"deploy-bundle" | "source"`.
This entry closed the bookkeeping: the last stale `deploy-package` reference
in resolve.test.ts was corrected. (s2-agent-optimization Phase A.)

### 1. lazy `-e <alias>` e2e  ✅ DONE (2026-07-12) — shipped in `src/__tests__/e2e-extensions.test.ts`; see git history for the recipe notes

### 2. Patch unit-coverage gaps

`src/patches/load-run-dir-resources.ts` and `skip-update-check.ts` have no
dedicated `.test.ts` (the other 13 patches do, incl. `set-package-dir`). Lower
ROI — these two are thin and exercised indirectly by the patch e2e +
`doctor --smoke` — but a focused unit per patch would pin each patch's env
gate + effect.

## Next-arc candidates (when this arc is resumed or closed)

- `cli` namespace deep audit (`src/cli/sessions/shared.ts`, `src/cli/args.ts` beyond numeric) — was filed as "not s2-agent" when the CLI was its own package; it is in-package as of the 2026-08-12 merge
- mlx pipeline hardening / the standing self-improve arc
