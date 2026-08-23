---
type: task
blocking:
---

## Question

Diet the superpowers bootstrap from ~2,050 tok to ≤950 (design ~918) per session/compaction: rewrite the two repo-owned sections in `src/superpowers.ts` — `piToolMapping()` → ~55 tok essentials + "Full contract: references/pi-tools.md — read BEFORE any subagent or SDD dispatch"; `piBoundaryOverrides()` → ~85 tok stage routing + `.planning/<effort>/` home + "Full rules: references/pi-routing.md" (new reference file absorbs removed detail: stage table, sdd-workspace/PI_PLANNING_EFFORT, no-effort fallbacks). Pinned `using-superpowers` body stays byte-identical. Re-pin `tests/bootstrap.test.ts` structure-over-prose (~40 substring pins → pointers + load-bearing tokens) + budget ratchet (sections ≤1,100 chars, total ≤5,900 chars). New `tests/references.test.ts` asserts detail moved-not-vanished. ADR-0010 documents; ADR-0008 future-work points at it. Keep stage words + grilling/to-spec in source (routing-contract greps them). User decision: trim-to-~900, NOT lean-pointer.

## Resolution

Landed 2026-08-21 (phase S2, PR branch feat/superpowers-s2-token-diet). `piToolMapping()` + `piBoundaryOverrides()` rewritten to terse essentials + deferral pointers ("Full contract: references/pi-tools.md — read BEFORE any SDD/subagent dispatch"; "Detail: references/pi-routing.md"); pinned `using-superpowers` body untouched. New `skills/using-superpowers/references/pi-routing.md` absorbs the stage table, artifact paths, sdd-workspace/PI_PLANNING_EFFORT, no-effort fallbacks; `capability?` added to pi-tools.md's param lists (was inline-only). Landed: sections 1,093 chars (ratchet ≤1,100), total 4,194 chars ≈ **~1,000 tok/session (was ~2,050; −~1,050/session)**. Tests re-pinned structure-over-prose + budget ratchet; new `tests/references.test.ts` pins detail-moved-not-vanished. ADR-superpowers-0010 written (INDEX row added); ADR-0008 future-work marked EXECUTED. Gates: superpowers 139/0 + typecheck; adr-citation/routing/skill-reference/seam 32/0; deployed 0.1.0+g1b77ff5 ships pi-routing.md; loop status all-PASS.

closed: (landed)
