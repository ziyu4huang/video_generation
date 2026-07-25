# Task 1 Report: coverage.ts pure core + export TRACKED_TOOLS + unit tests

## Status
**DONE**

## Summary

Task 1 implemented the pure core of the coverage analyzer and exported TRACKED_TOOLS for downstream consumption. All tests pass and no existing functionality was broken.

## Changes Made

### 1. Export TRACKED_TOOLS (`extensions/tool-gate.ts:224`)
- Added `export` keyword before `const TRACKED_TOOLS`
- Zero behavior change — additive only

### 2. Created `qa/coverage.ts` (pure core)
Implemented the following exports (no measureCoverage/main yet — Task 2):
- `DEFAULT_COVERAGE_THRESHOLD = 300`
- `UngatedTool` interface
- `CoverageReport` interface
- `analyzeCoverage(report, threshold, root)` — pure classification function
- `formatCoverage(r)` — human-readable report
- `assertSane(r)` — structural validation

### 3. Created `qa/coverage.test.ts` (fixture-based unit tests)
12 tests covering all specified cases:
- Heavy tool NOT in TRACKED_TOOLS → ungated
- Heavy tool IN TRACKED_TOOLS → gatedHeavy (not ungated)
- Builtin (source === "(builtin)") → never reported, even if heavy
- Sub-threshold tools → ignored
- Ungated sorted desc by tokens
- Threshold override respected
- Root passed through
- formatCoverage ✅ (healthy) and ❌ (gap) rendering
- assertSane: non-positive threshold, empty report, clean normal report

## Test Results

### coverage.test.ts
```
12 pass
0 fail
26 expect() calls
```

### Full package suite
```
225 pass
0 fail
485 expect() calls
```

All pre-existing tests pass — the TRACKED_TOOLS export is purely additive.

## Self-Review

- ✅ TRACKED_TOOLS export added exactly once (line 224)
- ✅ coverage.ts contains ONLY the pure core (no measureCoverage, no main)
- ✅ Imports are minimal:
  - `import type { SchemaCostReport } from "../../pi-agent-cli/src/commands/schema-cost.ts"`
  - `import { TRACKED_TOOLS } from "../extensions/tool-gate.ts"`
  - No unused imports (buildSchemaCostReport, resolveRepoRoot not imported yet)
- ✅ Tests cover all listed cases from the brief
- ✅ No behavior change to existing code

## Commit

**Commit:** bf58fded
**Subject:** feat(tool-gate): add coverage pure core (analyzeCoverage) + export TRACKED_TOOLS

```
bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts |   2 +-
bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts     | 121 +++++++++++++++++++++
bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts         | 108 ++++++++++++++++++
3 files changed, 230 insertions(+), 1 deletion(-)
```

## Next Steps

Task 2 will add `measureCoverage` and `main` to complete the coverage harness.
