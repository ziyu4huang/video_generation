# 02 — Fix the stale canonical map (2026-08-08-knowledge-pipeline/map.md)

## type

`task` (AFK-able)

## Question

The canonical map `2026-08-08-knowledge-pipeline/map.md` is internally stale: its Decisions-so-far says "Next build ticket is 10-impl … EXECUTE/SDD stage next", but 10-impl already shipped (PR #1242, squash `1fcb4504`). Re-baseline it so a fresh session reading the map sees the true frontier:

- Mark 10-impl shipped in Decisions-so-far; remove/replace the stale "next build ticket is 10-impl" line.
- Reconcile the still-open list to the verified set from ticket 01 (expected: **03, 07, 13, 14**, plus the un-implemented 3-tier drift behind closed 05; 15-Phase1 shipped — #1168).
- Note: ticket **15-Phase1 ALSO shipped** (#1168 `48df0b1a`) but `tickets/15` frontmatter still says `status: open` — fix that too. The canonical map is stale on TWO shipped tickets (10-impl + 15-Phase1), not one. (The origin/main commit `#1245` is an unrelated webui ticket — not canonical 07; ignore it.)
- Set a single recommended next-pick (and flag if the 3-tier-drift impl behind 05 should be re-ticketed as a fresh build ticket — see Not-yet-specified).

## blocked by

01 (audit confirms which build tickets are truly open)

## claimed

—
