# DO — `pin: true` memory field (quick win)

**UPSP pattern:** §1 (Pinned layer, §4.11) · **Decision:** DO (quick win) · **Effort:** XS–S

## What
Add a `pin: true` frontmatter field. Pinned entries are **never eligible** for eviction / consolidation / `offloaded_superseded` / FIFO purge — but they still decay in heat normally (pin protects *not-being-deleted*, not *not-decaying* — once decay exists).

## Why
1-field feature with real value: the user/agent can lock "always remember this." UPSP's cleanest single-field win.

## Acceptance
- `pin: true` parsed/encoded in frontmatter; mirrored to DB.
- Every eviction/consolidation path skips pinned entries.
- New test: a pinned entry survives an overflow-consolidation that evicts non-pinned peers.

## Scope hint
- `src/store/memory-format.ts` (parse/encode `pin`), `src/store/memory-store.ts` + consolidation eviction paths (skip pin), DB column mirror.
