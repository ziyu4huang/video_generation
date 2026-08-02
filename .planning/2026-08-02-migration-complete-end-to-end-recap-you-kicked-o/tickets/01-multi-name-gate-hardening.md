## Question

`buildEffectiveGates()` currently drops an entire fallback gate if ANY of its names is owner-declared (FOLLOWUPS #4, ~`tool-gate.ts:236`). During incremental rollout, a multi-name gate group migrated partway would silently un-gate its still-unmigrated siblings — fail-open. How should the merge resolve a gate whose name-list is partially migrated so that partial rollout never fail-opens a sibling?

Candidate resolutions (pick one in the grilling):
- **Per-name**: split the fallback gate so unmigrated names keep their fallback gate while migrated names take owner-declared — no name ever loses its gate.
- **All-or-nothing group**: if any name in a fallback gate is owner-declared, require ALL names to be declared or refuse to build (fail-closed at startup).
- **Explicit migrate-all flag**: owner declares the whole group atomically.

Recommend per-name (zero fail-open window, backward-compatible). Verify with a new test: a half-migrated multi-name group must keep unmigrated siblings gated.

type: grilling
blocked by:
claimed: main-session

## Resolution

**Decision: per-name resolution.** Each fallback gate's `names` are partitioned at merge time into declared vs undeclared. The fallback gate (keywords/requires/core) is kept for the UNDECLARED names; only owner-declared names leave the fallback (gated by their own tool-def `gating`). A gate with zero undeclared names is dropped. No name ever loses its gate — zero fail-open window during incremental rollout.

Implemented in `buildEffectiveGates()` (`extensions/tool-gate.ts`). Verified by a new TDD unit test: a synthetic 3-name fallback gate with one name owner-declared keeps the other two gated (was fail-open → now stays gated). Full package suite green.

status: closed
