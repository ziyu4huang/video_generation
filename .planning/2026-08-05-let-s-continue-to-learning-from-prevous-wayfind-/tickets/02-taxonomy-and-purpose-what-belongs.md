---
type: grilling
status: open
blocked by: 01
---

# 02 — Taxonomy & purpose: what belongs in the global failure store?

## Question

What is the failure-memory target *for*, and what belongs in it? The audit ([01](01-audit-the-failure-store.md)) shows the store is dominated by **operational tool-quirks about devops/git tooling** (`await_pr_merge`, `gh pr`) — not lessons about the memory extension or the project itself. Decide the scope rule:

- Should recurring **operational tool-quirks** (about arbitrary tools the agent happens to use) live in the *global* failure store at all, or in a separate per-tool / per-domain surface?
- Is the failure store for **curated, cross-session lessons** only — or does it also carry transient operational state?
- What's the inclusion test an entry must pass to earn a slot in the 40K budget?

This is the upstream decision: it determines what [dedup](04-dedup-identity-and-merge-rule.md) canonicalizes *among* and what [decay](05-decay-aging-and-supersede-policy.md) retires.

## Context

- The 45-tag mix (19 tool-quirk / 13 convention / 12 insight / 1 failure) suggests the "failure" target has become a catch-all for anything tagged — the `tool-quirk` category especially.
- `REJECTED.md` is silent on taxonomy; the categories (`failure`, `correction`, `insight`, `convention`, `preference`, `tool-quirk`) are defined in the memory policy but their *target* routing isn't questioned.

## Recommendation seed

Lean toward: the global failure store keeps **curated, durable, cross-session lessons**; recurring operational tool-quirks either (a) get a bounded quota, or (b) move to a per-tool quirks file so they don't crowd lessons. Put the actual cut to the user.
