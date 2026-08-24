# spec — s2-agent simplify

Source: user priority 2026-08-24 ("simplified codebase of bun-apps/s2-agent — re-org code, less duplicate keep simple, yet same quality"), explored by 3 read-only agents + 1 plan agent, scope confirmed (steady-full). Approved plan mirrored at the session plan file; this spec is the durable version.

## Non-goals

- No behavior change except flagged bugfix drift (map D5 agent-dir env honor; ext-doctor manifest-failure surfacing; envFlag "yes" widening in ticket 06).
- No defineCommand / help-text regeneration (map D2), no makeMockPi cross-package dedup (D3), no lazy-extensions removal, no mass file moves (D1).
- No changes to externally pinned files' locations: src/cli.ts, src/cli-sh.ts, src/patches/*, src/static-extensions.ts, src/run-dir/{manifest.json,check-deps.ts}, src/sh/{host-modules,ext-loader}.ts, src/pre-load-providers.ts, src/run-dir/registry.ts.

## Constraints (verified 2026-08-24)

1. registry-config.ts stays zero-import; manifest.json derived, freshness byte-compare; generator banners pin paths.
2. patches/index.ts dynamic imports are static literals; PATCH_TABLE order = execution order; patch-outcome.test.ts non-recursive scan of patches/*.ts; opt-off-not-opt-in invariant (index.test.ts).
3. cli-intercept-order.test.ts pins "./cli/dispatch.ts" + intercept ordering; scrub stays first import of both entries; cli namespace bypasses applyPatches (ADR 0001).
4. Test path-pins: ../args.ts parsePiArgs; ../dispatch.ts findCommandToken+runCli; ../sessions/{shared,passthrough,task-runner}.ts; ../extensions/registry.ts; ../commands/agent.ts AGENT_TOOLS; ../commands/url-to-vault.ts URL_TO_VAULT_TOOLS; ../commands/zk-extract.ts resolveInputs/resolveVault; ../commands/pdf-to-vault.ts readPipelineDoc; ../commands/workflow.ts buildMainSpec/parseWorkflowArgs.
5. ParsedArgs optional fields = hidden ext API (e.g. web-access `(parsed as any).save === true` at extensions/cli-subcommand.ts:87 — `save` row KEPT). Unknown-flag skipper swallows typos silently → new flag rows need a per-flag regression test (ticket 04).
6. e2e pins: help text + error wording; boot-smoke baseline pins `tools-metrics --schema-cost --json` byte-exact; e2e meta test pins VERSION output (dispatch.ts:59 lockstep with version-bump-cli).
7. pre-load-providers.ts side-effect-free; __piBakedProviders publish-before-first-getRegistry (#1985). Doctor must run with patches broken; tools-active-probe shared with deploy-e2e (never fork).
8. Repo mechanics: bun install from bun-apps/ only; never top-level cd; canonical package gates; local_ci ≤5 min; git/PR via devops CLIs; watchdog OFF for write-heavy implementers; independent reviewer = quality gate.

## Per-ticket done-when

Each ticket: `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; PR merged via devops chain (local_ci green); reviewer subagent pass. Additions:

- **01**: help-pin e2e green; `(parsed as any)` census recorded in the ticket before any flag-row removal.
- **02**: bundle-mode-anchor test green (cli/ excluded from cli-sh bundle verified empirically); PI_CODING_AGENT_DIR delta flagged in PR body.
- **03**: boot-smoke `tools-metrics --schema-cost --json` output byte-identical to baseline.
- **04**: same byte-identical gate; per-flag regression test added; ext `(parsed as any)` audit attached to the ticket.
- **05**: passthrough.test path-pin updated with the move; run.sh check-deps path untouched.
- **06**: patch-outcome + opt-off invariant tests green; envFlag "yes"-widening flagged; footer patch keep/remove decision recorded with evidence.
