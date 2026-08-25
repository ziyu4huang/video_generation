# 06 — seams B: clip/humanizer + findExistingRun + printTable adoption (+ lazy-extensions fold-in if it fits)

Source: map Context "Structure" D5-D9 clusters.

## Scope

- **clip/trunc ×3 → format.ts**: `dispatch.ts:299` inline `clip`, `task-runner.ts:65` `trunc` → one shared `clip(s, max)` in `src/cli/format.ts` (NOTE: format.ts:67 `clipSnippet` is a different beast — snippet window — keep separate).
- **Humanizers ×3**: `dispatch.ts:235 humanizeTokens`, `tools-metrics.ts:209` (secs), `:214` (pct) → format.ts (or leave if semantics genuinely differ — measure first).
- **findExistingRun twins**: `pdf-to-vault.ts:147-158` / `memory-to-vault.ts:97-104` — same skeleton, different policy (prefix+slug match vs newest-dir); ONE parameterized helper, policies stay distinct at call sites. Also collapse the one-line `writePipelineDoc`/`readPipelineDoc` re-wrappers if the parameterized helper makes them hollow.
- **printTable adoption**: `workflow.ts:208`, `agent-trends.ts:65` hand-rolled rows → printTable. NOTE: workflow.ts may already be gone via ticket 02 — skip if so.
- **`json ?` ternary ×8 + dry-run message ×2**: add a shared `emit()` ONLY where output shapes honestly converge; if shapes stay divergent ({error} vs {mode} vs raw), record that and skip (map D-cluster 8 explicitly allows this outcome).
- **lazy-extensions dead-path** (manifest.lazyExtensions always {}): fold in ONLY if the registry zero-import contract + manifest-types surface survive contact within this ticket's budget; else split into its own follow-up ticket (map Fog of war).
- **gitLines contract test** (reviewer recommendation on ticket 05): a small unit test locking `src/cli/git.ts`'s null-vs-empty distinction — non-zero exit → null; successful empty output → `[]`; the `?? []` consumer shape. Nothing pins it today (pipeline-gate.test.ts covers parsing only).

## Acceptance criteria

- [x] Byte-identical output where a helper absorbs an existing renderer (printTable adoption diffs proven on representative rows) — where adopted; skips measured+recorded in Outcome
- [x] emit()/skip decision recorded with the shape census
- [x] lazy-extensions fold-in-or-split decision recorded (SPLIT → ticket 11)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass

## Outcome (2026-08-25)

- **clip/trunc ×2 → format.ts `clip(s, max, trimTail=false)`** (the chart's ×3 counted workflow.ts, already gone in ticket 02): dispatch's listTools clip = `clip(s, 60, true)` (whitespace-normalized input wants the trailing-space-free cut); task-runner's trunc (12 call sites) = `clip(...)` default (quoted/JSON values keep every char). Byte-identical both sites. `clipSnippet` stays separate (match-window snippet, not a length cap).
- **Humanizers ×3 → SKIP, measured**: the three are three DIFFERENT domains, not three copies — dispatch `humanizeTokens` (M/K magnitude, exactly one definition + one consumer file), tools-metrics `fmtMs` (ms→"Nms"/"X.Xs" with magnitude-dependent decimals), tools-metrics `pct` (ratio). Nothing shares a seam; moving single-consumer functions is relocation, not dedup.
- **findExistingRun twins → SKIP, measured**: pdf-to-vault (slug-suffix match, first-in-readdir-order) vs memory-to-vault (pipeline.json presence, lexical-newest) share only a 3-line skeleton across 2 policy axes; a parameterized helper (prefix + keep-callback + select-callback) measures NET +LOC (~12 helper + 2×2 config vs 2×10 inline). Policies stay distinct at call sites per the ticket's own "parameterize, don't merge blindly" — here parameterization itself loses.
- **printTable adoption at agent-trends.ts verdict rows → SKIP, measured**: the row is a TEMPLATED line (`padEnd(28)` label + `padStart(5)`% → `padStart(5)`% + arrow + parenthesized tail with per-verdict text), not a column table — printTable's computed-width/2-space-join shape cannot reproduce it byte-identically. workflow.ts:208 site moot (file removed in ticket 02).
- **emit() → SKIP per shape census**: compact `{error}` ternary (memory-to-vault:194) vs compact `{mode,message}` (knowledge-pipeline:243) vs pretty `null,2` + renderer call (doctor.ts:363) vs pretty + multi-line console.error block (zk-query:98/125/170) vs pretty `{...report}` (agent-trends). A shared emit() would need payload+pretty+else-renderer params — the if/else itself. Map D-cluster 8's allowed outcome.
- **lazy-extensions dead-path → SPLIT to ticket 11** (surface: resolver 153 LOC + registry exports + derived manifest + generated static-extensions header + ext-doctor reader + 3 test files — exceeds budget exactly as Fog predicted).
- **gitLines contract test ADDED** (`src/cli/git.test.ts`, 3 cases from ticket-05 review): non-zero → null; successful-empty → [] (empty piped stdout is a truthy Buffer — the null branch never fires for empty output); consumer `?? []` shape.
