# 04 — Dedup / quality gate

---
type: grilling
blocked by: 02, 03   # need the staging location + the recognition criteria before designing the gate
status: open
---

## Question

Before the agent writes a candidate to `.planning/knowledge/`, should it check for near-duplicates — against existing L3 skills (the candidate is redundant) and the L2 graph (the lesson already converged)? And is the gate **on-capture** (block the write if dup) or **deferred to promotion** (let duplicates accumulate, sort them out when promoting via writing-skills)?

## What to build

A grilled decision on whether + where to gate. Candidate mechanisms:

- **Gate on-capture**: before writing, `knowledge_query` / `skill_manage view` for near-duplicates; skip or merge. Higher-quality staging; adds capture-time cost + a false-positive risk (suppresses a genuinely-different candidate).
- **Defer to promotion**: capture freely; writing-skills' RED phase naturally catches "this skill already exists" when pressure-testing. Simpler; risks a noisy staging dir.
- **Light signal, no block**: capture always, but tag the candidate with a dup-suspect flag (from a cheap check) for the promoter to see.

## Acceptance

- [ ] Gate decision (on-capture / deferred / signal-only), with rationale.
- [ ] If gating: the check mechanism named (which tools, against which stores).
- [ ] The decision balances noise-suppression against false-positive suppression of genuine candidates.
