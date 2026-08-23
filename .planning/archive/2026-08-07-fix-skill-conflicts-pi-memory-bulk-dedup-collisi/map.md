---
effort: 2026-08-07-fix-skill-conflicts-pi-memory-bulk-dedup-collisi
created: 2026-08-07
last: 2026-08-07
status: complete
---

# Wayfinder map: 2026-08-07-fix-skill-conflicts-pi-memory-bulk-dedup-collisi

## Destination

fix [Skill conflicts]                                                                                                          
  "pi-memory-bulk-dedup" collision:                                                                                        
    ✓ path (temp) ~/proj/video_generation__memory/bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md 
    ✗ ~/.pi/agent/pi-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md (skipped)                                          

  , I prefer all things need ot harden to  bundle pi agent itself , not write to personal ~/.pi/

## Notes

_(none)_

## Decisions so far

<!-- none yet -->

## Not yet specified

<!-- none -->

## Out of scope

<!-- none -->

## Cross-effort links (2026-08-08 review)

- **Covered-by:** `2026-08-07-how-is-current-memory-finding-duplicate-conflict` (dedup layer design + quality baseline) and `2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or` (dedup promoted into the card-agnostic store contract, ticket 01). This stub has no tickets/decisions; the bulk-dedup/skill-conflict concern is addressed by those efforts. Close as no-op/superseded.
> Closed 2026-08-15: no-op/superseded per its own cross-effort review note (covered by dup-conflict + knowledge-card efforts).
