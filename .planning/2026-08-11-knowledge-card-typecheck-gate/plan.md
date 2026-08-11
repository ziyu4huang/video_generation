---
effort: 2026-08-11-knowledge-card-typecheck-gate
issue: "1206"
status: active
created: 2026-08-11
---
# Plan — knowledge-card typecheck gate (TDD)

The gate IS the test: `( cd bun-apps/pi-agent-ext-knowledge-card && bun run typecheck )`
must exit 0.

## Task 1 — Wire the gate (RED)
- [x] `tsconfig.json` created (mirrors `pi-agent-ext-core-task`; `include` trimmed
      to `src/`, `extensions/`, `__tests__/`).
- [ ] Add `"typecheck": "bunx tsc --noEmit"` to `package.json` scripts.
- [ ] Confirm RED: `bun run typecheck` -> 17 errors (baseline).

## Task 2 — Make it green (GREEN) — all edits in `__tests__/`
| File:line(s) | Fix |
|---|---|
| coverage.test.ts 52,72,100,119 | delete the `cwd: vault,` line (dead — ingestRecords never reads cwd) |
| retrieve.test.ts 580 | remove `cwd: v` from the inline IngestOptions literal |
| ingest.test.ts 804 | `source: "workflow-jsonl"` -> `source: "workflow-jsonl" as const` |
| semantic.test.ts 95,107,114,131 | add `source: "workflow-jsonl",` to each IngestOptions literal |
| semantic.test.ts import block | add `type Embedder,` to the `from "../src/semantic.ts"` import (resolves TS2304 + the downstream TS7006) |
| sink.test.ts 51,65 | delete the stale `// @ts-expect-error:...` comment line; keep the guarded `knowledgeCard(...)` call |

## Task 3 — Verify
- [ ] `bun run typecheck` exits 0.
- [ ] `bun test` all pass.
- [ ] No cwd-coverage regression (collectInputFiles tests still green).

## Risk
Low. All fixes are test-only and mechanical. cwd deletion is provably safe (dead
field). The `source` additions were latent runtime bugs (`source` was undefined).
