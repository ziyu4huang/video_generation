# Task 2 report — measureCoverage wrapper + qa:coverage script + integration test

**Status:** DONE (implementer subagent's turn ended mid-re-run before commit/report; verified + committed by the orchestrator)

## What was done

All edits the brief specified, made by the implementer subagent (HEAD `bf58fded` → working tree):

1. **coverage.ts imports merged** (line 19): `import { buildSchemaCostReport, resolveRepoRoot, type SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts";` (type merged into the value import; stays at top — no mid-file import).
2. **measureCoverage + main appended** at the end of coverage.ts (lines 117–140): async wrapper calls `buildSchemaCostReport(resolved)` → `analyzeCoverage`; `main()` prints `formatCoverage`, runs `assertSane`, exits 1 on structural fail; `if (import.meta.main) void main();`.
3. **Integration test appended** to coverage.test.ts (lines 123–135): calls `measureCoverage()`, asserts `totalTools > 0`, `assertSane(r)` empty, `gatedHeavy >= 1`.
4. **`qa:coverage` script** added to package.json (line 20): `"qa:coverage": "bun run qa/coverage.ts"`.

## Flake fix (added by the implementer)

The integration test boots the real offline collector (`buildSchemaCostReport`), which takes ~5.9s — over bun's default 5s per-test timeout. The implementer added a `15000` ms timeout to the `it(...)` call (3rd arg) so it no longer flakes. This is what the subagent was re-running when its turn ended.

## Verification (run by orchestrator)

- Focused: `bun test qa/coverage.test.ts` → **13 pass / 0 fail** (integration case 5938ms, within the 15s cap).
- Full suite: `bun test` → **226 pass / 0 fail** (488 expect calls, 7 files). Up from 225 (Task 1) + 1 integration test.
- Standalone: `bun run --cwd ... qa:coverage` → exit 0. Output:
  ```
  threshold:   300 tok/req
  tools:       56 total · 22 heavy (excl. builtins) · 22 gated-heavy ✅
  ungated:     0 heavy tool(s) not tracked by any gate
  ✅ every heavy tool is tracked by a gate (or is a builtin)
  ✅ coverage complete (non-gating by default)
  ```

## Real-world signal

**The repo is currently fully gated** — 0 ungated heavy tools; all 22 heavy (non-builtin) tools are tracked by some gate. `gatedHeavy = 22` is the stable structural count the spec wanted. No forgotten gates.

## Commit

`<filled by orchestrator>` — `feat(tool-gate): add measureCoverage wrapper + qa:coverage script + integration test`
