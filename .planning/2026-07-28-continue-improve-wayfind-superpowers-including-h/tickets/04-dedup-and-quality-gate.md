# 04 — Dedup / quality gate

---
type: grilling
blocked by: 02, 03   # need the staging location + the recognition criteria before designing the gate
claimed: wayfinder-session
status: closed
---

## Question

Before the agent writes a candidate to `.planning/knowledge/`, should it check for near-duplicates — against existing L3 skills (the candidate is redundant) and the L2 graph (the lesson already converged)? And is the gate **on-capture** (block the write if dup) or **deferred to promotion** (let duplicates accumulate, sort them out when promoting via writing-skills)?

## What to build

A grilled decision on whether + where to gate. Candidate mechanisms:

- **Gate on-capture**: before writing, `knowledge_query` / `skill_manage view` for near-duplicates; skip or merge. Higher-quality staging; adds capture-time cost + a false-positive risk (suppresses a genuinely-different candidate).
- **Defer to promotion**: capture freely; writing-skills' RED phase naturally catches "this skill already exists" when pressure-testing. Simpler; risks a noisy staging dir.
- **Light signal, no block**: capture always, but tag the candidate with a dup-suspect flag (from a cheap check) for the promoter to see.

## Acceptance

- [x] Gate decision (on-capture / deferred / signal-only), with rationale.
- [x] If gating: the check mechanism named (which tools, against which stores).
- [x] The decision balances noise-suppression against false-positive suppression of genuine candidates.

## Resolution

**Decision: defer to promotion — no capture-time gate.** The agent captures a candidate freely whenever the skill-worthy bar (ticket 03) is met; dedup happens at promotion, not at capture.

**Rationale**
1. The important dedup — a candidate that duplicates an **existing L3 skill** — is ALREADY caught by writing-skills' RED phase, which searches `skills/` during pressure-testing. We do not duplicate that checkpoint with a new capture-time mechanism.
2. Candidate-vs-candidate dups are acceptable **staging noise** — `.planning/knowledge/` is project-scoped + PR-reviewable + cleanable, not a curated store.
3. Capture must stay **light** (ticket 01: main-session, agent-judged, on-save/recurrence). A multi-call capture-time gate contradicts that.
4. The **worse failure is false-positive suppression** — a genuine candidate lost because its surface looked dup-like. Staging clutter is cleanable; a suppressed candidate is not. Deferral accepts the clutter to avoid the suppression.

**The dedup mechanism (named, though deferred — no new capture-time tooling):**
- **Candidate ≈ existing skill**: caught by writing-skills' RED phase (existing checkpoint) at promotion.
- **Candidate ≈ another candidate**: free implicit signal from filesystem name-collision — when the agent writes `.planning/knowledge/<name>.md` and a same/similar name already exists, it notices (no extra tool call). If noticed, merge or disambiguate at the agent's discretion (advisory, not a block).

*Rejected:* **on-capture gate** — capture-time cost (multiple tool calls at the capture moment) + false-positive suppression of a genuinely-different candidate (the worse failure). **Signal-only flag** — marginal value (RED already covers the important case) + mild tension with light capture.

*(Resolves ticket 04. Leaf ticket — blocks nothing; frontier narrows to {05}. Fog: feedback loop still awaits 05.)*
