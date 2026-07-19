# 02 — Document superpowers README with wayfind reference

---
type: task
status: closed
claimed: wayfinder-session
---

# 02 — Document superpowers README with wayfind reference

## Question

Add a "Related packages" or "Ecosystem siblings" section to `pi-agent-ext-superpowers/README.md` that links to wayfind as a complementary package in the same methodology family.

## What to build

One section or line in `bun-apps/pi-agent-ext-superpowers/README.md`, placed after the existing "How it works" section and before "Layout":

- Heading: `## Related packages`
- One bullet: `[**wayfind**](../pi-agent-ext-wayfind/README.md) — decision-chain skills (grilling, wayfinder, domain-modeling) for the decompose-and-decide phase that precedes Superpowers' brainstorming→writing-plans flow.`
- Ensure no other content in the README is modified or reformatted

## Acceptance

- [ ] `bun-apps/pi-agent-ext-superpowers/README.md` has a `## Related packages` section with a wayfind link
- [ ] The relative path `../pi-agent-ext-wayfind/README.md` resolves correctly
- [ ] No other content was altered

## Resolution

Added a `## Related packages` section between "How it works" and "Layout" with a single bullet linking to wayfind.

Verified: link target `../pi-agent-ext-wayfind/README.md` exists. No other README content altered.

## Acceptance (met)

- [x] `bun-apps/pi-agent-ext-superpowers/README.md` has a `## Related packages` section with a wayfind link
- [x] The relative path `../pi-agent-ext-wayfind/README.md` resolves correctly
- [x] No other content was altered
