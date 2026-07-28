# 03 — Template content + injection mechanics

---
type: grilling
blocked by: 01, 02   # need the capture moment + the candidate format before writing the template
status: open
---

## Question

What exactly does the always-on prompt-injected template say, and how is it injected? This is the heart of the bridge — the text that turns "the agent learns a lesson" into "the agent captures a skill candidate." Two parts:

1. **Content** — the recognition criteria (what makes a lesson skill-worthy: reusable + procedural + not-already-a-skill + not-noise), the capture format (pointing at ticket 02's candidate fields), and the trigger guidance (firing at ticket 01's chosen moment).
2. **Injection mechanics** — extend hermes' existing memory-policy block (`prompt-context.ts` → `MEMORY_POLICY_PROMPT`), or a new dedicated block? Token budget (policy-only mode is deliberately lean — the template must be cheap)?

## What to build

A grilled decision + a drafted template (prose + the capture-format stub). Candidate injection points to grill:

- **Extend the memory-policy block** (`MEMORY_POLICY_PROMPT` / `_COMPACT`): co-located with the existing "when to search" guidance; one block; but grows the always-injected cost.
- **New dedicated block** in `prompt-context.ts`: separable, can be toggled; but adds a second always-on block.
- **A trigger-on-description skill** (lighter, on-demand): NOT always-injected, but depends on SDO firing at the right moment (ticket 01's moment).

## Acceptance

- [ ] Injection point chosen (extend policy / new block / skill), with token-cost rationale.
- [ ] Recognition criteria named (the skill-worthy predicate).
- [ ] Template text drafted (prose + capture-format stub), pointing at ticket 02's fields + ticket 01's moment.
- [ ] The decision respects superpowers' writing-skills SDO discipline (the template must not itself read like a skill the agent follows *instead of* writing-skills).
