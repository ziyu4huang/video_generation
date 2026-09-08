# t02 / MC-4 — docs-only fast path

status: closed (2026-09-09)

- `MATRIX_IRRELEVANT_PREFIXES` += `.agents/` (coverage note: read-in-session
  docs; structural gates run regardless of scoping; a future COMPILED artifact
  under .agents/ must re-review the list).
- Tests: .agents-only → zero packages (never fail-open); mixed → exactly that
  package + dependents; unmapped path alongside .agents/ → still fail-open.
- Effect: #2185-shaped one-file memory chores stop running the 29-package
  matrix (~8 min → structural gates only).
