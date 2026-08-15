---
type: grilling
claimed: pi-agent (autonomous — user pre-agreed, option B)
status: closed
---

# 03 — .superpowers/sdd/ runtime scratch disposition

## Question

`.superpowers/sdd/` holds superpowers' **runtime scratch**: `progress.md` (the anti-compaction SDD ledger), `review-<base>..<head>.diff` (review packages), `task-<N>-brief.md` (subagent dispatch briefs). It lives at the repo root, **not** under `.planning/`. The user's directive is "all planning artifacts under `.planning/`."

**Decide:** is `.superpowers/sdd/` (a) runtime/ephemeral **state** that stays at the repo root (ensure gitignored, document as "runtime scratch, not a planning document"), or (b) align it under `.planning/<effort>/`?

### Recommendation

**Leave at repo root — document as runtime scratch, not a planning artifact.** Reasons:

- Its contents are **execution state + scratch diffs**, not planning documents: the progress ledger is anti-compaction resume state; review diffs and task briefs are transient hand-off files. The "all planning docs under `.planning/`" principle is about *documents*, not *runtime state*.
- `.superpowers/sdd/` is written by **scripts** (`sdd-workspace`, `review-package`, `task-brief`) that resolve the repo root via `git rev-parse --show-toplevel` — coupling them to an effort-scoped dir would fight that repo-root assumption and add effort-discovery complexity for ephemeral files.
- The vault SOP doc should classify it in a distinct **"runtime scratch"** tier, separate from both the effort-scoped planning docs and the cross-cutting domain artifacts.

### On resolution

Confirm the disposition; the vault SOP doc ([04](04-sync-docs-to-reality.md)) records it as the runtime-scratch tier. Verify `.superpowers/` is gitignored (check, don't assume).

## Resolution (closed 2026-07-19 — autonomous, user pre-agreed with recommendation)

**Leave `.superpowers/sdd/` at the repo root** — it is runtime scratch, not a planning document.

- **Gitignore verified ✓:** `git check-ignore .superpowers/sdd/progress.md` returns the path (ignored). No action needed.
- The vault SOP doc ([04](04-sync-docs-to-reality.md)) classifies it in a distinct **"runtime scratch"** tier (progress ledger / review diffs / task briefs — ephemeral execution state), separate from the effort-scoped planning docs and the cross-cutting domain artifacts. No code/script edits — the repo-root assumption of the SDD scripts is intentional and preserved.
