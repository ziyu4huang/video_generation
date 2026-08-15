---
type: grilling
blocked by: [02]
status: closed
---
## Question

**If tool-owners declare their own gates (ticket 02 → (e)/(c)/(a)), who owns the delicate co-occurrence / `requires` (noun∧verb) tuning?** tool-gate's `GATES` carry per-gate `requires` rules (e.g. flux2 fires only on noun∧verb to kill false-fires like "docker image"). The S2 audit (2026-07-20) carefully removed over-broad bare words (`image`/`video`/`pdf`/`movie`/...) — that precision is hard-won.

If each extension declares its own gate, does it also own its noun∧verb tuning — risking that an extension author unfamiliar with the false-fire gotchas regresses precision — or does tool-gate keep a tuning/override layer over discovered gates?

Resolves only after 02 picks a delegating mechanism. If 02 picks (d) drift-guard (tool-gate keeps the taxonomy), this ticket is **moot → rule it out of scope** at that point.

## Resolution (2026-08-02)

Resolved by ticket 02: under owner-declares delegation, the `gating.requires?` co-occurrence tuning is **OWNER-owned** — the extension that knows its tool's intent owns its noun∧verb rules. The S2 false-fire gotchas become a **tuning GUIDE for owners** (documentation delivered with the migration), not a separate ticket or tool-gate-side override layer. Closed.
