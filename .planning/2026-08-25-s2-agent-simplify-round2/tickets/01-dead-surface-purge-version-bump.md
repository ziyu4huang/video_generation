# 01 — dead surface purge + version bump 0.7.10 → 0.7.11

Source: map.md Context "Docs + scripts" (measured 2026-08-25). No blocker; this PR also carries the effort's `.planning/` chart.

## Scope

Delete (all receipts in map Context):
- `bun-apps/s2-agent/baselines/schema-cost-baseline.json` (whole `baselines/` dir — zero readers; LIVE baseline is repo-root `scripts/schema-cost-baseline.json`, untouched).
- package.json scripts: `cli`, `list` (zero invocations repo-wide), `test:e2e` (superseded by ext-devops run-test.ts which sets PI_AGENT_E2E itself).
- `workflows/lib/lexical-overlap-check.mjs` + `workflows/lib/lexical-overlap-check.test.ts` (393 LOC, no consumer — knowledge-distill.js does not import it).
- Dead citation to nonexistent `workflow-retrieval-quality.test.ts` (`src/cli/__tests__/workflow.test.ts:14` — the only live mention; .planning/ archives keep theirs as history).
- ~~Empty dir `src/cli/__tests__/__fixtures__/`~~ — CORRECTED: the dir holds the LIVE `boot-smoke.baseline.json` (boot-smoke.test.ts:20 reads it). NOT deleted; chart claim was wrong.

ADR 0005 (`docs/adr/0005-provider-catalog-from-s2-agent.md`, zero citations): read it, then EITHER delete (if superseded — record why in the ticket) OR add a live citation from the code it governs. Do not leave it orphaned.

Version: `bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent --patch` (0.7.10 → 0.7.11; syncs package.json + dispatch VERSION).

## Outcome (2026-08-25)

- Deletions: baselines/schema-cost-baseline.json, workflows/lib/lexical-overlap-check.{mjs,test.ts}, scripts cli/list/test:e2e, workflow.test.ts:14 dead phrase — all landed on branch chart/s2-agent-simplify-round2.
- ADR 0005 verdict: **RE-CITED, kept.** Content still governs the live PROVIDERS single-catalog invariant (pre-load-providers.ts exists and is the one catalog); citation added at pre-load-providers.ts:2. Deleting would lose the baked-providers trade-off record (workspace-dep-on-sibling-tool rationale).
- `__fixtures__/` claim corrected — fixture kept (see Scope).
- Version 0.7.11: version-bump-cli --patch ok=true, files = package.json + src/cli/dispatch.ts (VERSION lockstep).

## Acceptance criteria (done-when)

- [x] All deletions landed; repo-wide grep for each deleted filename returns no CODE consumers — remaining mentions are prose/history only (kcard docs/kg-improvement-plan.md:221,262 + vault note name lexical-overlap-check as history; no importer anywhere — reviewer-verified 2026-08-25)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (1046 pass / 0 fail; re-verified by independent reviewer)
- [x] `diff` proves repo-root `scripts/schema-cost-baseline.json` untouched
- [x] ADR 0005 verdict (deleted-with-reason or re-cited) recorded here
- [x] Version 0.7.11 in package.json AND dispatch VERSION lockstep (e2e meta VERSION pin green)
- [ ] devops local_ci green (≤ 5 min); PR merged via devops chain; reviewer pass (local_ci pass 121.5s + reviewer READY recorded 2026-08-25; merge pending)
