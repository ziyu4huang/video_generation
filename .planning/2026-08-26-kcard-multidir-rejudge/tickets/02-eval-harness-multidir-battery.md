# 02 — Generalize resource-eval.mjs for multi-dir trees + blind battery

Status: open · Blocks: 03 · Blocked by: 01

## What

`bun-apps/scripts/resource-eval.mjs` assumes a single flat `pages/` dir
(corpus path resolution, coverage check, question targets). Generalize to a
recursive page set with tree-relative path targets, and author the blind
question battery for the family corpus.

## How

1. Replace `pagesDir` readdir with a recursive walk (same exclusions as
   `walkTree`: dot-entries, tier sidecars). Question `targetPages` become
   tree-relative paths (e.g. `v2-ecn/<slug>/pages/page-003`).
2. Keep the arm set + metrics + throwaway-ns/±receipts contract IDENTICAL
   (same scoring code path — the comparison must stay apples-to-apples with
   the 2026-08-25 receipts).
3. Battery (~25 questions, blind-authored from the companions' own TOCs,
   English): majority DIRECTORY-DISCRIMINATING (answerable from exactly one
   doc dir — e.g. DROM register semantics, Retimer lane-margin requirements,
   a specific ECN's change), minority within-doc (control, comparable to the
   2026-08-25 set). Negatives preserved. Key sections to page SPANS, not the
   heading page (resource-tier answer-key lesson).
4. Unit-test the walk/target-matching change with a tiny fixture tree.

## Done when

- [ ] `resource-eval.mjs --corpus usb4-family --battery <new>` passes the
      coverage precheck (no absent targets) and rejects a bad target
- [ ] Battery file committed with TOC anchors per question
- [ ] Fixture unit test green (`bun run test` canonical gate for the package
      owning the script — check which package's gate covers bun-apps/scripts)
- [ ] Receipt in this ticket; map `last` touched
