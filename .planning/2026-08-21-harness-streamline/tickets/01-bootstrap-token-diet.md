---
type: task
blocking:
---

## Question

Diet the superpowers bootstrap from ~2,050 tok to ≤950 (design ~918) per session/compaction: rewrite the two repo-owned sections in `src/superpowers.ts` — `piToolMapping()` → ~55 tok essentials + "Full contract: references/pi-tools.md — read BEFORE any subagent or SDD dispatch"; `piBoundaryOverrides()` → ~85 tok stage routing + `.planning/<effort>/` home + "Full rules: references/pi-routing.md" (new reference file absorbs removed detail: stage table, sdd-workspace/PI_PLANNING_EFFORT, no-effort fallbacks). Pinned `using-superpowers` body stays byte-identical. Re-pin `tests/bootstrap.test.ts` structure-over-prose (~40 substring pins → pointers + load-bearing tokens) + budget ratchet (sections ≤1,100 chars, total ≤5,900 chars). New `tests/references.test.ts` asserts detail moved-not-vanished. ADR-0010 documents; ADR-0008 future-work points at it. Keep stage words + grilling/to-spec in source (routing-contract greps them). User decision: trim-to-~900, NOT lean-pointer.
