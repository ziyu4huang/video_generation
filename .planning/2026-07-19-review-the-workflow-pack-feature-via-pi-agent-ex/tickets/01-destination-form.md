## Question

What is the destination (done-state) form of this effort — a design spec + template, a spec plus one living reference pack, or a full in-place change to the extension?

type: grilling
status: closed
claimed: chart-session (2026-07-19)

## Resolution

**Full in-place change.** This effort locks decisions AND modifies `pi-agent-ext-workflow` within its tickets: new manifest fields, resolver/loader changes for pack-local state + bundled agents, the shipped folder template, a sample pack, and tests. Each ticket still resolves a *decision* (the wayfinder default of "plan, don't do" holds per-ticket); the execution (code/tests) lands as the natural consequence of the resolved decisions, sized to one session each.

Rejected:
- **Spec + template only** — rejected because the change is tightly scoped to one extension the user owns, and a spec-only handoff adds a round-trip with no isolation benefit.
- **Spec + one reference pack** — rejected; the reference pack alone doesn't validate the engine/resolver changes, so it's an awkward middle.
