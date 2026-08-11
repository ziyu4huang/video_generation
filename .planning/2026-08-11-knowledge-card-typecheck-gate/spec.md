---
effort: 2026-08-11-knowledge-card-typecheck-gate
issue: "1206"
status: active
created: 2026-08-11
---
# Knowledge-card typecheck gate

## Problem (GitHub #1206)
`bun-apps/pi-agent-ext-knowledge-card` has no `tsconfig.json` and no `typecheck`
script — type errors are caught only at runtime. 9 of 10 sibling packages already
enforce a typecheck gate; knowledge-card is the gap.

## Goal
Add a self-contained `tsconfig.json` (mirroring `pi-agent-ext-core-task`) and a
`typecheck` script (`bunx tsc --noEmit`) to `package.json`, then make the gate
green by fixing the surfaced errors.

## Surfaced errors (17 — all test-only; src/ and extensions/ are clean)
Three cohesive root causes:
1. `IngestOptions` evolved: the `cwd` field was removed (moved into
   `collectInputFiles`'s 2nd arg) and `source: SourceFamily` was added as
   required. 10 errors.
2. `Embedder` type unimported in `semantic.test.ts`. 5 errors (3× TS2304 +
   2× downstream TS7006 implicit-any on the `texts` param).
3. 2 stale `@ts-expect-error` directives in `sink.test.ts` — the guarded call no
   longer errors because `fakePi()` returns `as never`. 2 errors.

## Coverage-preservation note
Deleting `cwd` from the 5 `ingestRecords` call sites loses ZERO coverage: those
sites pass pre-parsed `KnowledgeRecord[]` to `ingestRecords`, which never reads
`cwd` (grep: `opts.cwd` is read at exactly one site — `collectInputFiles`,
`src/ingest.ts:234`). cwd-scoped file collection has its own dedicated tests
(`ingest.test.ts:394` describe block, `ingest-generic.test.ts:147`).

## Non-goals
- Repo-wide typecheck aggregation — only this package.
- Adding `typescript` / `@types/bun` devDeps — the gate works via `bunx tsc`
  against the hoisted workspace `node_modules`, matching `pi-agent`'s convention.
