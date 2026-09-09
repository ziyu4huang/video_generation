# t05 — Check-script DECISION (recorded, per class) + sv-analyzer skip loudness

## Goal

The 19-packages-without-a-real-`check`-script question (arc-17's systemic
finding, absorbed from the dead test-hygiene premise) is CLOSED as a recorded
adopt-or-reject per class with rationale — a decision artifact, not a
19-package fix spree. sv-analyzer's wasm-gated tests skip loudly if they
currently skip silently.

## Files

- `.planning/2026-09-10-self-arc-19/check-scripts-decision.md` (new,
  committed) — the decision document.
- `bun-apps/s2-agent-ext-sv-analyzer/tests/sv-analyzer.test.ts` — loud-skip
  conversion, ONLY if step 2 shows today's skip is silent.

## Steps

1. **Enumerate** the 19 packages from the COMMITTED arc-17 audit JSON
   (`.planning/2026-09-09-self-arc-17/evidence/self-arc17-audit-result.json`
   — t04 dependency; do not read the scratch copy). Cross-check against
   current reality: for each package, read `package.json` scripts TODAY and
   note drift since the audit (some may have gained real `check` scripts —
   hermes did, in arc-18; it is NOT in the 19 anymore if the audit already
   excluded it — record what is true now).
2. **Classify** what is actually there (let the data pick the classes; do not
   pre-invent a taxonomy — Fog note in map). Plausible shape, to be confirmed:
   packages with real src surface + tests (adopt the house triple — queued
   maintenance arcs, per-package), thin/generated/vendored-heavy packages
   (reject with reason), already-fixed (record as done).
3. **Decide** per class: adopt-or-reject, rationale, and for adopted classes
   the queue vehicle (successor maintenance arcs, hermes-arc-18 as the
   specimen recipe). Every package lands in exactly one class row.
4. **sv-analyzer**: run its tests; observe the wasm-gated skip behavior. If
   silent: convert to a loud skip using the hermes `localDescribe` pattern
   (`tests/store/surreal/_helpers.ts` specimen — copy the pattern, no
   cross-package import), gates green. If already loud: record
   verified-no-op.
5. Summarize the decision rows into the map's `## Decisions` at closeout
   (t06) as one decision entry pointing at the doc.

## Acceptance

- Decision doc committed: per-class adopt-or-reject with rationale, one row
  per package, no orphan packages, current-reality drift recorded.
- sv-analyzer either converted (loud skip receipt) or verified-no-op receipt.
- ZERO other packages' scripts touched.
- sv-analyzer package gates green if changed (resolve real script names from
  its package.json).

## Out of scope

- Executing any adopted class's fix (that is successor maintenance arcs'
  work, queued via the decision doc).
- Touching ci-recipe/local_ci gate resolution logic.
