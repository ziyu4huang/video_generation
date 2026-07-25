# Task 4 Report: Document the Coverage QA Axis

**Status:** DONE

**Commit:** 2e8ef8b7 - "docs(tool-gate): document the coverage QA axis"

## Summary

Added a new "## QA" section to `bun-apps/pi-agent-ext-tool-gate/README.md` with three subsections:

1. **### Savings** (`qa/savings.ts`) - Documents the savings measurement that validates the "~8,500 tok/req saved" claim
2. **### Miss-rate** (`qa/miss-rate.ts`) - Documents the miss-rate measurement that analyzes keyword recall from telemetry
3. **### Coverage** (`qa/coverage.ts`) - Documents the coverage check that identifies ungated heavy tools

The Coverage subsection was added with the exact content from the task brief, adapted to match the heading level (`###`) and markdown style of the neighboring Savings and Miss-rate subsections.

## Location

The new QA section appears after the "## Testing" section and before "## Installation" in the README, creating a logical progression from testing the code to measuring its quality attributes (savings, miss-rate, coverage) to installation instructions.

## Verification

- Markdown is clean with proper heading hierarchy (`##` for main section, `###` for subsections)
- Code blocks use triple-backticks correctly
- Content accurately reflects the real implementation:
  - Default threshold: 300 tok/req
  - Builtins excluded from coverage check
  - Verdict is non-gating by default, gating under `--strict`
  - All CLI commands shown match the actual implementation
- No duplicate content
- English language used throughout (as per project guidelines)

## Notes

Since the README did not previously have a QA/verification section, I created the entire "## QA" section with all three subsections (Savings, Miss-rate, Coverage). The Savings and Miss-rate subsections were drafted based on the file headers and documentation from `qa/savings.ts` and `qa/miss-rate.ts`, while the Coverage subsection used the exact content from the task brief.

The section placement (between Testing and Installation) creates a logical flow: how to test → how to measure quality → how to install.
