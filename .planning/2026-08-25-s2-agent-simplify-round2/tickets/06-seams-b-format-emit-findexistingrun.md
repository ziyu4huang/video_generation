# 06 — seams B: clip/humanizer + findExistingRun + printTable adoption (+ lazy-extensions fold-in if it fits)

Source: map Context "Structure" D5-D9 clusters.

## Scope

- **clip/trunc ×3 → format.ts**: `dispatch.ts:299` inline `clip`, `task-runner.ts:65` `trunc` → one shared `clip(s, max)` in `src/cli/format.ts` (NOTE: format.ts:67 `clipSnippet` is a different beast — snippet window — keep separate).
- **Humanizers ×3**: `dispatch.ts:235 humanizeTokens`, `tools-metrics.ts:209` (secs), `:214` (pct) → format.ts (or leave if semantics genuinely differ — measure first).
- **findExistingRun twins**: `pdf-to-vault.ts:147-158` / `memory-to-vault.ts:97-104` — same skeleton, different policy (prefix+slug match vs newest-dir); ONE parameterized helper, policies stay distinct at call sites. Also collapse the one-line `writePipelineDoc`/`readPipelineDoc` re-wrappers if the parameterized helper makes them hollow.
- **printTable adoption**: `workflow.ts:208`, `agent-trends.ts:65` hand-rolled rows → printTable. NOTE: workflow.ts may already be gone via ticket 02 — skip if so.
- **`json ?` ternary ×8 + dry-run message ×2**: add a shared `emit()` ONLY where output shapes honestly converge; if shapes stay divergent ({error} vs {mode} vs raw), record that and skip (map D-cluster 8 explicitly allows this outcome).
- **lazy-extensions dead-path** (manifest.lazyExtensions always {}): fold in ONLY if the registry zero-import contract + manifest-types surface survive contact within this ticket's budget; else split into its own follow-up ticket (map Fog of war).

## Acceptance criteria

- [ ] Byte-identical output where a helper absorbs an existing renderer (printTable adoption diffs proven on representative rows)
- [ ] emit()/skip decision recorded with the shape census
- [ ] lazy-extensions fold-in-or-split decision recorded
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass
