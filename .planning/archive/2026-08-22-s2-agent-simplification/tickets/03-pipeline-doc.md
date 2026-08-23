# T3 — pipeline-doc micro-module

New `src/cli/pipeline-doc.ts`: `timestamp()`, `iso()`, generic
`writePipelineJson<T extends { updatedAt: string }>(path, doc)`,
`readPipelineJson<T>(path)` (existsSync-guarded parse → null).

Adoption:

- pdf-to-vault.ts — keeps its doc types and the D5 legacy-stage migration as a
  wrapper over `readPipelineJson`; deletes local timestamp/iso/write/read (D6).
- memory-to-vault.ts — same adoption; keeps exported names (`writePipelineDoc`
  / `readPipelineDoc`) as thin wrappers so its tests stay untouched.

`findExistingRun` stays per-command (D2: slug-match vs newest-dir are different
algorithms).

**Verify**: pdf-to-vault.test.ts (D5), memory-to-vault.test.ts, full suite.

Status: **closed**
