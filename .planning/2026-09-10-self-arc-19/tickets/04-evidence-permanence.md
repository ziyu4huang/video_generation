# t04 — Evidence permanence: `.planning/<effort>/evidence/` convention, adopted by THIS arc

## Goal

Committed maps stop citing gitignored scratch. The convention
(`.planning/<effort>/evidence/`, size-capped, text-only) becomes the committed
tier for load-bearing receipts; the one live violation (arc-17 audit JSON) is
migrated; this arc's own evidence lands there from day one.

## Files

- `.planning/CONVENTIONS.md` — the convention paragraph (caps, format rule,
  citation rule: maps cite the committed copy, never `output/`).
- `.planning/2026-09-09-self-arc-17/evidence/self-arc17-audit-result.json`
  (new; byte-copy of `output/self-arc17-audit-result.json`, 46,432 bytes —
  measured 2026-09-10, well under cap).
- `.planning/2026-09-09-self-arc-17/map.md` — citation update: point the
  existing reference at the committed path (one-line change + note that the
  scratch original remains transient).
- `.planning/2026-09-10-self-arc-19/evidence/` (new) — this arc's own:
  - `t01-red-bar.txt` (the RED run receipt from t01 commit A),
  - `t02-dry-run.json` (repoint dry-run on the real queue),
  - `t03-review-receipt.json` + harvest check output (from t06's dogfood if
    not yet captured — land what exists at PR time),
  - `arc-plan-prompt.md` + `plan.md` + `plan-receipt.json` (this arc's
    planner specimen: the prompt that cited the queue head),
  - `explore-selfarc-deep-plan.md` (copy of the exploration report this map's
    Context cites).

## Caps (D6)

- ≤256KB per file, ≤1MB per effort dir, text/JSON only — no binaries, no
  screenshots-in-disguise (base64 blobs rejected). Enforced at review time by
  the executor checking `du`/file types before commit; a CI size guard is
  NOT built this arc (queued thought, recorded in the ticket resolution).

## Steps

1. Write the CONVENTIONS.md paragraph; keep it to one tight block.
2. Copy the arc-17 JSON (verify byte-identical with `cmp` after copy);
   update arc-17's map citation; `grep -rn "output/self-arc17-audit-result"
   .planning/` must return ZERO committed-map hits afterward.
3. Populate this arc's evidence dir with everything already receipted
   (t01/t02 artifacts exist by execution order; t03's land with t06 if the
   dispatch happens pre-merge — commit what exists, note the pending ones).
4. Size/type check the evidence dir against the caps; record numbers in the
   ticket resolution.

## Acceptance

- No committed map cites `output/self-arc17-audit-result.json` anymore
  (grep-clean), and the committed copy is byte-identical (cmp receipt).
- This arc's evidence dir exists, populated, under caps.
- CONVENTIONS.md carries the convention; `.gitignore` untouched (evidence/
  lives under `.planning/<effort>/`, which is already committed-by-rule).

## Out of scope

- Retro-migrating other efforts' scratch (benchmark receipts etc. — they
  migrate when their owning map is next touched).
- A CI-enforced size guard for evidence/.
- Moving the queue-head next-goal files themselves (they stay scratch; the
  successor GOAL is scratch until its arc opens an effort).
