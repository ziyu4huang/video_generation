## Question

Apply a **structural** fix that makes the failure-store-noise cluster (near-duplication / re-bloat) stop recurring — an automated check, not another manual dedup pass.

Scope graduates from ticket 00's root-cause. Likely shape (confirm against 00 before building): an automated near-dup detector — either at write time (check-before-save, blocks a near-duplicate entry) or as a CI/periodic compaction that flags high-similarity entries. The exact mechanism is ticket 00's output. Must coexist with the harness lock (use the `memory` API, not raw `.md` surgery during live sessions — see `pi-memory-bulk-dedup` pitfall #6).

**Acceptance (done)**: the detector demonstrably fires — construct two near-duplicate entries, confirm the mechanism flags/blocks the second, RED→GREEN. Bonus if it also catches one real existing near-dup pair in the current store.

**blocked by:** 00 (need the root-cause before scoping the fix)

**type:** task
