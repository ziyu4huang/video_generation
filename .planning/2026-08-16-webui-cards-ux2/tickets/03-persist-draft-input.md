---
type: task
status: open
---

# 03 — persist draft-card input across refresh/replay

## Question

Draft cards (blocking:false) keep in-progress field values in DOM only (v1); a refresh or snapshot replay loses the typed input and re-renders bare form structure. Persist draft input (e.g. sessionStorage keyed by cardId, or stash in the snapshot) so refresh/replay restores in-progress answers; live + replay; tests; keep innerHTML <= 8.
