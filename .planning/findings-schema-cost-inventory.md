# Findings: schema-cost related files inventory

Generated: 2026-08-21 · read-only inventory, simplified to a reference log.
Status: **done** — closed 2026-08-22.
Task: find all files in the repository related to 'schema-cost'.

## TL;DR

Four moving parts: **CLI command** (s2-agent), **pure submodule** (power-tool, zero deps), **CI gate** (scripts/ + devops, warning-only at >5%), **baselines** (two checked-in JSONs). Per-extension regression tests pin their own schema-cost. Full prose detail was trimmed — paths below are the reference.

## Reference log

### Core implementation

| Path | Role |
|---|---|
| `bun-apps/s2-agent/src/cli/commands/schema-cost.ts` | CLI command; `discoverExtensionEntries()` derives from `run-dir/manifest.json`; `createCapturingApi()` Proxy mock; exports report builders/formatters |
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/index.ts` | public API — re-exports estimate/analyze/merge/format/contract |
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/estimate.ts` | core heuristic: `approxTokens = round((description.length + JSON.stringify(parameters).length) / charsPerToken)` |
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/types.ts` | `ToolCost`, `SchemaCostReport`, … |
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/format.ts` | text/JSON output |
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/contract.ts` | tool contract validation (hasExecute, schemaValid) |

### CI / DevOps

| Path | Role |
|---|---|
| `scripts/check-schema-cost.ts` | argv shim → `runSchemaCostCheck`; exit 0 = within threshold / 1 = hard failure |
| `bun-apps/s2-agent-ext-devops/src/schema-cost-check.ts` | gate logic; live instrument vs baseline; >5% inflation = WARNING (non-blocking); injectable `SpawnFn` |
| `scripts/schema-cost-baseline.json` | baseline A — 61 tools / 18810 tok |
| `bun-apps/s2-agent/baselines/schema-cost-baseline.json` | baseline B — 71 tools / 21693 tok |

### Tests

| Path | Role |
|---|---|
| `bun-apps/s2-agent-ext-power-tool/src/schema-cost/__tests__/estimate.test.ts` | golden fixtures + CLI↔submodule PARITY CONTRACT |
| `bun-apps/s2-agent/src/cli/__tests__/schema-cost.test.ts` | CLI unit tests incl. manifest-error handling (audit I-7) |
| `bun-apps/s2-agent-ext-devops/tests/schema-cost-check.test.ts` | gate tests; temp JSONs, no real CLI spawn |
| `bun-apps/s2-agent-ext-{knowledge-card,hermes-memory,obsidian}/…/perf/schema-cost.regression.test.ts` | per-extension schema-cost regression |

### Docs / examples / integration

| Path | Role |
|---|---|
| `bun-apps/s2-agent-ext-power-tool/docs/schema-cost.md` | submodule docs (static half only) |
| `bun-apps/s2-agent-ext-power-tool/examples/schema-cost-quick.mjs` | runnable example |
| `bun-apps/s2-agent/src/cli/commands/tools-metrics.ts` | `--schema-cost` flag reuses CLI report builders |

### Notes

- Vault knowledge-graph notes reference schema-cost under `./vaults_root/{study-news,pi-agent-vault}/Zettelkasten/knowledge-graph/` (13 files, incl. `_archive/`).
- Historical planning tickets: `.planning/done/2026-08-02-improve-extension-co-operation-less-hard-couplin/tickets/03-schema-cost-strategy-under-isolation.md`, `.planning/2026-08-16-hermes-leanrag-simplify/tickets/10-schema-cost-hard-pin.md`.
- Peripheral mentions (`src/cost.ts`, `src/report.ts`, `extension-contract.test.ts` in power-tool) — no separate schema-cost logic; out of scope.
