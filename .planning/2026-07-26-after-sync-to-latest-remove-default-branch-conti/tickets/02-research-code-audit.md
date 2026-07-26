---
type: research
status: closed
---

# 02 — Code audit: src / extensions / scripts / migrations

## Question

What dead code, duplication, and structural cleanup exists in the extension's
TypeScript code (`src/`, `extensions/`, `scripts/`, `migrations/`)?

## Findings (charted 2026-07-26)

**The code is already minimal — there is little to simplify.**

| path | lines | role |
|---|---|---|
| src/superpowers.ts | 301 | bootstrap: `resources_discover` → expose `skills/`; inject `using-superpowers` once per session/compaction; skill-exclude logic |
| src/index.ts | 31 | lib entry |
| extensions/superpowers.ts | 14 | registered extension entry |
| scripts/rebaseline-upstream-skills.ts | 70 | re-freeze skill fixtures from upstream |
| scripts/update-superpowers.sh | 42 | pull + apply upstream skill updates |
| scripts/apply-patches.sh | 35 | apply `migrations/` patches |
| migrations/unified-planning-dir.patch | 12 | one patch |

Total ~505 lines, of which only ~346 is runtime code (`src/`). No dead-code
pockets surfaced; the bootstrap is a single focused responsibility.

**Divergence is already a managed mode**: `scripts/rebaseline-upstream-skills.ts`
+ `update-superpowers.sh` + `apply-patches.sh` + `migrations/` form an
upstream-sync toolchain. Editing skill content (ticket 04) does not need new
machinery — it uses the existing rebaseline flow.

➡️ Conclusion: a dedicated code-simplification decision is **not warranted**
(negligible surface to cut). Recorded as **Out of scope** on the map. The
leverage is in skill *content*, not code.
