# 01 — Document wayfind README with superpowers umbrella

---
type: task
status: closed
claimed: wayfinder-session
---

# 01 — Document wayfind README with superpowers umbrella

## Question

Add a clear "Part of the Superpowers ecosystem" indicator to `pi-agent-ext-wayfind/README.md`, so readers immediately see that wayfind's skills belong under the superpowers methodology umbrella.

## What to build

One visible section/badge in `bun-apps/pi-agent-ext-wayfind/README.md`:

- Under the title line, add a sentence: "Part of the **Superpowers** ecosystem — the grilling + wayfinder family is the decomposition-and-decision phase of the Superpowers methodology."
- Optionally add a small "Part of Superpowers" badge or inline link to `../pi-agent-ext-superpowers/README.md`
- Ensure no other content in the README is modified or reformatted

## Acceptance

## Resolution

Added a blockquote line directly under the `# pi-agent-ext-wayfind` title:

> **Part of the [Superpowers](../pi-agent-ext-superpowers/README.md) ecosystem** — the grilling + wayfinder family is the decompose-and-decide phase of the Superpowers methodology.

Verified: link target `../pi-agent-ext-superpowers/README.md` exists. No other README content altered.

## Acceptance

- [x] `bun-apps/pi-agent-ext-wayfind/README.md` has a visible "Part of Superpowers" reference near the top
- [x] The link to `../pi-agent-ext-superpowers/README.md` is correct (relative path works from the wayfind README location)
- [x] No other content was altered
