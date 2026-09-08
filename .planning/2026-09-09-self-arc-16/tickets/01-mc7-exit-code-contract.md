# t01 / MC-7 — exit-code contract, pinned

status: closed (2026-09-09)

- `PR_FINISH_ABORT_REASONS` exported (10 reasons, unique, `[a-z_-]+`).
- Bidirectional drift guard: source `abort("…")` literal SET === tuple (a new
  reason without a row fails; a retired reason lingering fails too).
- Edges: usage error → 2; `--dry-run` → 0; `pr-status-failed` e2e → 1.
- Note: `dirty_tree` is the one historical snake_case member (regex allows it).
