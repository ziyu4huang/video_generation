# 03 — Generalize the `__pi*` seam-key formalization

---
type: grilling
blocked by: 02   # generalize the pattern ticket 02 settles on one seam
status: closed
claimed: wayfinder-session
---

## Question

The coexistence contract spans a family of ~7 `globalThis` seam keys: `__piCoreTaskStatusWidget` (status), `__piWayfindActive` / `__piGoalActive` (yield coordination), `__piPlanIncomplete` / `__piPlanSummary` / `__piPlanPhases` (the coordinator's published reads), `__piWayfindGrill`, `__piKickHeartbeat`. They're **stringly-typed constants scattered across packages** (wayfind `constants.ts`, core-task `status-widget.ts`) with no shared contract module. Should the pattern settled in ticket 02 generalize across the whole `__pi*` family — and if so, where does the canonical contract live?

## What to build

A grilled decision on whether/how to generalize the status-widget formalization (ticket 02's output) to the entire `__pi*` seam family. Open sub-questions:
- Does the contract need a **single shared module** (and where — a new tiny package? a file both import via subpath?), or is **per-seam test coverage** enough?
- Which keys are *coordination* (wayfind↔core-task yield) vs *data* (the `__piPlan*` reads) — do they warrant different formalization?
- Is there a key that's actually safe to leave undocumented (low blast radius)?

This ticket also graduates the map's **Not yet specified** "shared contract module vs inline" fog once 02 picks a mechanism.

## Acceptance
- [x] A decision on generalize-vs-leave-per-seam, with the chosen contract home (if any) named.
- [x] Each `__pi*` key is classified: formalized / test-guarded / accepted-as-documented.
- [x] If a shared module is chosen: its location and import discipline are specified (respecting the jiti/globalThis constraint). *(N/A — no shared module chosen; see below.)*

## Resolution

**Generalize — and via a more robust mechanism than per-seam file curation.** Two grilled sub-decisions, both confirmed against the recommendation:

1. **Scope = all 8 keys** (not 6 cross-extension, not a curated subset). The 2 intra-core-task globals (`__piGoalActive`, `__piKickHeartbeat`) drift silently too — a `globalThis` string rename is invisible to `tsc` even within one package — and including them is ~free. The guard’s premise (“string drift is invisible to `tsc`”) holds for intra-package globals as much as cross-extension ones.
2. **Function-valued keys get KEY AGREEMENT only; no shape guard.** The status widget (the one OBJECT-valued key) keeps its method-set SHAPE invariant. Rationale for function keys: TS signatures are erased at runtime (a static signature guard would check annotation *text* — fragile), and every consumer already defensively checks `typeof === "function"` → graceful fallback, never a silent break. The dominant drift vector for them is the key rename, which invariant 1 catches.

**Contract home = the `SEAM_KEYS` array in `bun-apps/tests/seam-contract.test.ts` — NO shared runtime module.** This confirms ticket 02’s fog-#1 resolution: the canonical contract lives in the *guard itself* (a test-time spec), not a package both sides import. Respects the jiti/globalThis constraint (zero runtime edges added).

**Mechanism upgrade over ticket 02:** rather than curating publisher/consumer *files* per key (fragile — the `__pi*` wiring is inconsistent: some via literals, some via imported constants, some published-but-not-yet-consumed), the KEY check became two **family-wide** invariants over the token surface:
- **NO ORPHANS** — every `__pi*` token referenced in production source (as a quoted literal OR a `.property` access; prose like `__piPlan*` matches neither and is excluded) is a registered `SEAM_KEY`. A rename creates an orphan → loud fail. Adding a new `__pi*` key without registering it fails too — that registration *is* maintaining the contract.
- **NO DEAD KEYS** — every registered `SEAM_KEY` is actually referenced (the spec stays honest).

This subsumes ticket 02’s 3-site status-widget key check for the dominant vector (rename): a rename in any site produces an orphan either way. The one regression — a *silent consumer-drop* (a consumer deletes its reference while the key lives elsewhere) is no longer caught for the status widget — accepted: lower-severity (behavioral tests catch it), and catching it would require the brittle per-file curation we generalized away.

**Classification per key (acceptance #2):**

| key | classification |
|-----|----------------|
| `__piCoreTaskStatusWidget` | **test-guarded (key + shape)** — object-valued; method-set SHAPE applies |
| `__piWayfindActive`, `__piGoalActive`, `__piKickHeartbeat` | **test-guarded (key)** — `() => boolean`/`() => void`; shape accepted-as-documented |
| `__piPlanIncomplete`, `__piPlanSummary`, `__piPlanPhases` | **test-guarded (key)** — `(cwd) => T`; shape accepted-as-documented (return-shape guard would be TS-annotation text, fragile) |
| `__piWayfindGrill` | **test-guarded (key)** — `(sessionId) => boolean`; shape accepted-as-documented |

(No key was left merely “formalized/accepted-as-documented” without a test — all 8 are test-guarded on the key.)

**Verified fails-loud** on all three vectors: simulated key rename → `ORPHAN __pi* KEYS`; simulated stale spec entry → `DEAD SEAM_KEYS`; simulated `addSection` rename → `SEAM SHAPE DRIFT`. Baseline + post-restore: 3 pass / 0 fail. `test:deps` sibling guard unaffected (5 pass).

**Map fog #2** (whether superpowers should gain awareness of the `__pi*` surface) is *not* resolved by this ticket — it depended on 03 making the surface a “published contract,” and 03 did, but only as a *test-time spec* (not a runtime/importable module). superpowers remains zero-globals/instructional; giving it awareness of a test-only spec has no runtime effect, so fog #2 graduates as **“no — superpowers stays out; the contract is enforced by CI, not by extension code.”**
