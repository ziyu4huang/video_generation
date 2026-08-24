# spec — s2-agent simplify round 2

Source: user directive 2026-08-25 evening ("structure / documents and scripts still too complicated; too much duplicate and unnecessary test; is ultracode/workflow still necessary????"), measured 2026-08-25 by four read-only explore agents (map.md Context holds the receipts). Durable companion to `map.md`; tickets live in `tickets/`.

## Non-goals

- No re-litigating round-1 REJECTED merges (printModel, gating unify, ensure-model-tiers — map D1).
- No defineCommand/help-text regeneration (~1,900 LOC, map D3), no makeMockPi cross-package dedup, no mass file moves (map D6).
- No changes to externally pinned file locations: src/cli.ts, src/cli-sh.ts, src/patches/*, src/static-extensions.ts, src/run-dir/{manifest.json,check-deps.ts}, src/sh/{host-modules,ext-loader}.ts, src/pre-load-providers.ts, src/run-dir/registry.ts.
- No engine-side (s2-agent-ext-ultracode) surgery in this effort beyond the s2-agent-side disposition ticket 02 encodes; full REMOVE is rejected on the hard-dependency evidence (map D4).

## Constraints (verified 2026-08-25)

1. Round-1 constraints carry over unchanged: registry-config zero-import + manifest freshness byte-compare; patch-outcome non-recursive scan; cli-intercept-order pins; boot-smoke byte-exact `tools-metrics --schema-cost --json`; e2e help/version pins; ParsedArgs optional fields are a hidden ext API (`(parsed as any).` readers).
2. The LIVE schema-cost baseline is repo-root `scripts/schema-cost-baseline.json` (ext-devops schema-cost-check.ts:85); `bun-apps/s2-agent/baselines/` is a dead pre-rename snapshot — deleting it must not touch the root file.
3. Test deletions are per-candidate with quoted surviving assertions (map D5); a deletion whose equivalence proof cannot be quoted stays.
4. Test-utils consolidation (ticket 04) must not move e2e/_helpers.ts's runCli path (imported by name across e2e suites) — promote by re-export or wrapper, verify with the full e2e tier.
5. ext-doctor.ts:32's `PI_AGENT_DIR`-based root derivation is verified deliberate-or-drift BEFORE ticket 05 migrates it.
6. Ticket 02 must keep WorkflowManager importable by ext-movie-director / ext-flux2 / tool-gate (map D4 dependency census) — whatever it trims, `bun run --cwd bun-apps/s2-agent-ext-movie-director` gates + typecheck stay green.
7. Repo mechanics: bun install from bun-apps/ only; canonical package gates (`bun run --cwd bun-apps/s2-agent test` + `typecheck`); local_ci ≤ 5 min; PRs via devops CLIs; reviewer subagent = quality gate; watchdog OFF for write-heavy implementers.

## Per-ticket done-when

- **01**: dead files gone; `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; root baseline untouched (diff proves); version 0.7.11 in package.json + dispatch VERSION (version-bump-cli --patch); local_ci green; ADR 0005 verdict recorded in the ticket.
- **02**: map D4 choice executed or documented; movie-director + tool-gate + flux2 typecheck/tests green; receipts land in CONTEXT.md; local_ci green.
- **03**: each deletion's equivalence proof quoted in the ticket; full suite green; net LOC delta recorded.
- **04**: one makeMockPi, one spawn harness, one tmpdir helper; e2e tier green via run-test.ts; net −100+ LOC.
- **05**: envFlag/repo-root/agent-dir/git-spawn consolidated; ext-doctor case verified first; no file moves; PI_CODING_AGENT_DIR honored at agent-trends (behavior delta flagged in PR if user-visible).
- **06**: clip/humanizer/printTable/findExistingRun consolidated; `emit()` only where shapes converge; lazy-extensions fold-in only if zero-import contract survives (else split ticket); suite green.
- **07**: guard test fails when the pinned pi-coding-agent dist's setExtensionStatus no longer calls requestRender; pinned against the CURRENT dist (green today).
