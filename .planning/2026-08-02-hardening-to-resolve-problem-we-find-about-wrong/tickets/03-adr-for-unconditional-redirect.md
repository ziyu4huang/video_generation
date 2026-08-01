# ADR for unconditional redirect?

type: grilling
claimed: pi-agent (main session, 2026-08-02)
claimed: pi-agent (main session, 2026-08-02)

## Question

Making the redirect **unconditional** (not effort-gated) contradicts ADR-0005's
"Never write to the upstream paths *when an effort is active*" framing. Does
this change warrant a new ADR (supersede/amend ADR-0005), per the
domain-modeling offer-ADR-sparingly test (hard-to-reverse ∧ surprising ∧ real
trade-off)?

Candidate answers (grill one at a time, with a recommendation):

- **Yes — write ADR-0006.** *Recommended.* The change is repo-wide (forces every
  ad-hoc brainstorm into `.planning/`), reverses a documented conditional, and
  has a real trade-off (ad-hoc artifacts now persist as dated dirs vs. the old
  "dropped under docs/superpowers/" nonchalance). All three criteria hold. The
  ADR records *why* the redirect is unconditional and the chosen no-effort
  default (from ticket 01).
- **No — amend ADR-0005 in place.** Treat it as a clarification, not a reversal.
  Lighter, but ADR-0005 is *accepted*; silent amendment erodes the ADR record.
- **No ADR at all.** Argue it's an implementation detail. Rejected by the
  criteria above — it's a documented, reversible-only-with-effort convention
  shift.

Blocked by: [01 — No-effort artifact location](01-no-effort-artifact-location.md)
(the ADR's content depends on the chosen no-effort default) — ✅ 01 closed
2026-08-02 (auto-create dated dir); unblocked. — ✅ 01 closed
2026-08-02 (auto-create dated dir); unblocked.

## Notes

- Drafting the ADR waits on 01; the *decision to write one* can be taken now.
- If written, link it from this ticket's resolution and from `map.md`
  Decisions-so-far.

## Resolution

**Decision: Yes — write ADR-0006.** A new ADR superseding ADR-0005's "when an
effort is active" clause on the no-upstream-path rule, leaving ADR-0005 intact
(the wayfind↔superpowers disjoint-subpath layout stands) with a pointer
0005 → 0006.

All three domain-modeling offer-ADR-sparingly criteria hold:
- **Hard-to-reverse**: repo-wide default artifact-location change.
- **Surprising without context**: a future reader sees an unconditional redirect
  and needs to know why ad-hoc artifacts now persist as dated dirs.
- **Real trade-off**: alternatives existed (require-effort, fixed-dir); we picked
  auto-dated for specific reasons (ticket 01).

ADR-0006 content: the unconditional no-upstream-path rule + the no-effort
default (auto-create `.planning/<YYYY-MM-DD>-<slug>/` from ticket 01) + the
guard form (text assertion + repo lint from ticket 02). Drafted as part of
ticket 04.

Status: closed (2026-08-02)

## Resolution

_(pending — grilling in progress, 2026-08-02)_
