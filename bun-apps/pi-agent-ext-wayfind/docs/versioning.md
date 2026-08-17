# Versioning policy

## Why wayfind and superpowers diverge on purpose

| package | version | upstream lineage |
|---|---|---|
| `@repo/pi-agent-ext-wayfind` | `0.1.0` | Pi-native port of Matt Pocock's decision-chain skill suite (grilling / wayfinder / domain-modeling). |
| `@repo/pi-agent-ext-superpowers` | `6.1.1` | Pi-native port of Superpowers (Primer Radiant) — tracks the upstream's v6.x line. |

The two numbers diverge because **each package tracks a different upstream**, not
because of carelessness. wayfind's `0.1.0` reflects an early, independently-versioned
port; superpowers' `6.1.1` mirrors Primer Radiant's major line. Forcing them to a
single shared number would be artificial — they are different products with
different release cadences.

## Policy (consistency = process, not matching numbers)

- Both packages use **semver**, independently, each following its own upstream.
- A version bump in one does **not** trigger a bump in the other.
- The divergence is **intentional and documented** (here) — not a defect to fix.

This is the "usage consistency" outcome of the `2026-07-26-review-wayfind-
superpowers-pi-extension-simplfie` effort (ticket 03): consistency means a shared
*scheme* and an explicit rationale, not identical version strings across packages
that port different upstreams.

## Redirect-stub expiry (OPEN-3 resolution, 2026-08-16)

`skills/ask-matt/SKILL.md` carries a redirect table for six skills deleted
2026-08-16 (merged into the superpowers extension — see README's "Locally
deleted skills"). One release of grace: the table is deleted at the next
wayfind release marker — the **`0.2.0` minor bump** (the first version bump
after `0.1.0`; semver minor per the policy above, since the deletions are a
backwards-incompatible change to the skill surface that users are given one
release to absorb). When bumping the package to `0.2.0`, remove the "Redirects
(skills merged into superpowers)" section from `skills/ask-matt/SKILL.md`.
