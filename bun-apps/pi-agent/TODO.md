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

### 1. lazy `-e <alias>` e2e  ✅ DONE (2026-07-12)

Shipped in `src/__tests__/e2e-extensions.test.ts` (describe "e2e: SOURCE lazy
`-e <alias>` splice loads the extension"). Two tests, gated on `PI_AGENT_E2E`
alone so they run at the default `medium` tier:
- alias run: `-e pi-agent-ext-zai-mcp` → splice rewrites to abs factory path →
  extension loads (matched ≥ 1, zero load errors).
- control: without the alias, the non-eager fixture is NOT loaded (matched = 0).

**Fixture note (recipe was stale):** the original recipe proposed `-e flux2`, but
flux2 is now in the EAGER manifest (so a no-alias control would still load it →
matched > 0, no causal proof). `workflow`/`dynamic-workflows` (the declared
`lazyExtensions`) now point at an eager package too (backwards-compat, SDK-dedup'd).
Used `pi-agent-ext-zai-mcp` instead: NOT eager + exactly one `.ts` under
`extensions/` (directory-fallback resolves) + registers tools (probe-visible).
`movie-director` was rejected (2 `.ts` files → fallback can't pick).

### 2. Patch unit-coverage gaps

`src/patches/load-run-dir-resources.ts`, `set-package-dir.ts`, and
`skip-update-check.ts` have no dedicated `.test.ts` (only `default-model-env`
and `index` do). Lower ROI — these are thin and exercised indirectly by the
patch e2e + `doctor --smoke` — but a focused unit per patch would pin each
patch's env gate + effect.

## Next-arc candidates (when this arc is resumed or closed)

- `cli` namespace deep audit (`src/cli/sessions/shared.ts`, `src/cli/args.ts` beyond numeric) — was filed as "not pi-agent" when the CLI was its own package; it is in-package as of the 2026-08-12 merge
- mlx pipeline hardening / the standing self-improve arc
