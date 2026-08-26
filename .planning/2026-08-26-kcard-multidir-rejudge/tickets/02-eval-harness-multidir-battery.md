# 02 — Generalize resource-eval.mjs for multi-dir trees + blind battery

Status: closed 2026-08-26 · Blocks: 03 · Blocked by: 01 (closed)

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

## Receipt (2026-08-26)

**Script** (`resource-eval.mjs`):
- Recursive corpus walk (dot-entries skipped ⇒ tier sidecars never enter the
  page set — same invariant the old flat readdir had); `tree` = corpus root
  basename.
- Target resolution: full tree-relative path (required on multi-dir) or
  legacy bare basename (auto-resolves on single-dir corpora; ambiguous
  basename = hard error with the candidate list + guidance). Exit 2 on any
  unresolvable target, before Surreal/vault — coverage contract unchanged.
- Generic-baseline id fix (found during generalization): the adapter ids
  records `generic:<slug(basename)>` and ingest upserts by id — on a 41-dir
  corpus the 41× `page-001` records would collapse onto ONE card. The eval
  now namespaces ids per doc dir (`@<docSlug>`). FAIR: the suffix lives in
  the stem (identity) only; the embedded text is title/body/tags
  (`semantic.ts:cardEmbedText`), so the baseline sees exactly what the
  resource lane sees (basename + body, never the path).
- Generic-arm matchers unified into `genericMatch` (stem `generic-<bn>` or
  `generic-<bn>-<docSlug>`; dash boundary keeps `page-003` off `page-0030`).
  Resource arms match `uri === resolvedTarget` exactly.
- `--check-only` added: walk + coverage precheck only, exit 0/2 — the
  fixture self-test. **Test-home decision**: NO package gate covers
  `bun-apps/scripts/` (root has only named `test:*` scripts, none sweep it;
  the old script was untested too) — the check-only mode + the negative
  fixtures below ARE the fixture test, recorded here in lieu of a unit test
  a canonical gate would silently skip.

**Battery**: `.planning/2026-08-26-kcard-multidir-rejudge/eval/questions.json`
— 26 questions (16 `dir`-class: 3 DROM, 4 CM-Guide, 2 Inter-Domain, 2
Re-Timer, 1 DVSEC, 4 ECN; 10 `within`-class main-spec controls reused from
the blind 2026-08-25 set) + 2 negatives (reused). Page offsets recorded in
meta: Inter-Domain file page = doc page + 7 (roman front matter — caught by
spot-verification when the +0 assumption missed); all others +0; main spec
+44. Every target spot-verified to contain its section heading/content.

**Fixture runs (all 2026-08-26):**
- family corpus + new battery → `26 graded + 2 negatives; absent 0`;
  `1263 pages across 41 dirs` — exit 0
- ambiguous `page-001` → hard error naming 41 candidate dirs — exit 2
- absent `v1-ecn/nope/...` → hard error — exit 2
- LEGACY compat: old flat corpus + old 2026-08-25 battery → `21 graded,
  absent 0` — exit 0 (basename fallback path works)

**Fog item resolved** (map: 839-vs-840): the 2026-08-25 receipt's
`setup.resource.inserted` was **844** — 839 pages + 1 combined root `.md` +
4 tier sidecar rows. The "839 L2 rows" shorthand was the page count only.
The new corpus strips the combined file by construction (map D2), so the
family run's L2 = exactly 1263 pages.

## Done when

- [x] `resource-eval.mjs --corpus usb4-family --battery <new>` passes the
      coverage precheck (26/26, no absent targets) and rejects bad targets
      (ambiguous + absent fixtures, both exit 2)
- [x] Battery file committed with TOC anchors per question (+ class +
      page-offset meta)
- [x] Fixture verification green (`--check-only` mode; no package gate owns
      `bun-apps/scripts/` — decision recorded above)
- [x] Receipt recorded here; map `last` touched
