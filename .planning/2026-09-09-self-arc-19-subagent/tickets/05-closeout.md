# t05 — close-out: docs PR, status flips, back-links, successor next-goal

Status: open (blocked by t04)
Files: `.planning/2026-09-09-self-arc-19-subagent/map.md`,
`.planning/2026-09-06-self-arc-13/map.md`, `.planning/2026-09-06-self-arc-14/map.md`,
plus the back-link targets named below. ONE docs PR through the devops chain
(map D8). Version-bump only if `bun-apps/s2-agent/**` changed in this arc (ext-only ⇒
none).

## Work items

1. **Status flips** (audited 2026-09-09): `2026-09-06-self-arc-13/map.md` frontmatter
   `status: planning` → `done`; `2026-09-06-self-arc-14/map.md` `status: active` →
   `done`. Their `2026-09-08-*` successors are already done — add one line under each
   flipped map noting the twin (same name, different date folder) to prevent future
   confusion.
2. **This map**: `status: done`, `last:` bumped, Shipped-as section (PR numbers,
   receipt folder names incl. the liveModelSlot-latched dispatch receipt, schema-cost
   delta numbers from t02).
3. **Reciprocal back-links** (convention): add to `2026-09-06-self-arc-12` (builds-on
   source), `2026-09-06-self-arc-9`, `2026-09-08-self-arc-14` (its receipt folder is
   this arc's false-FAIL baseline), `2026-09-08-self-arc-13` (worktree-isolation chart
   handed forward).
4. **Successor next-goal**: per the session-closeout SOP / self-reflect-next-goal
   strict v2 — write `output/next-goal-<ts>.md` BEFORE reporting done, validated
   (hands-off arc close-out rule). Candidate chart items already recorded in this map's
   Fog of war: writable fan-out with worktree isolation (branch
   `feat/self-arc-13-b3-migrate` exists), cross-OS tui-drive leg.
5. Chart-only items stay charted: do NOT implement them in this PR.

## Acceptance

- Docs PR merged; both stale statuses read `done` on origin/main.
- Shipped-as cites PR numbers + the latched dispatch receipt path.
- Successor next-goal written + validated; `output/` artifacts not committed.
