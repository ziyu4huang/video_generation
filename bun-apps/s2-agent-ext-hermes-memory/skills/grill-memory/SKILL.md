---
name: grill-memory
description: Use when running a grill-me session — inform each recommendation from memory and capture resolved decisions via grill_decision.
---

# grill-memory: make grills learn from the user's experience

Companion to `grilling`. Two protocols per decision.

## READ — inform each recommendation from memory

Before formulating your recommended answer for a decision, call `memory_search`
scoped to that decision and its trade-off:

```
memory_search({
  query: <the sub-decision + its trade-off keywords>,
  target: "user",
  categories: ["preference"]
})
```

Grill captures are user-traits, so they live in the portable `user` target
(USER.md), labelled `preference`. (Pure avoids — "tried X, it failed" — still land
in the `failure`/lesson target; search it as a fallback when the decision is about
something that previously went wrong.) Fold relevant hits into your recommendation
with a short citation — e.g. *"Recommendation: X. (Context: you've preferred X in
similar trade-offs.)"* If nothing relevant returns, recommend from reasoning alone
(cold start is fine).

## WRITE — capture each resolved decision via grill_decision

After the user answers each decision, call `grill_decision` exactly once:

```
grill_decision({
  decision: <the sub-decision>,
  recommendation: <your recommended answer>,
  userAnswer: <the user's actual answer>,
  signal: "reject" | "refine" | "confirm" | "preference" | "insight",
  notes: <optional — a durable phrasing, OR "project-scoped" if this is a
          repo-specific decision that belongs in CONTEXT.md/ADR instead>
})
```

The gate runs in the tool, not here. Classify the signal honestly:
- `reject` — the user contradicted or rejected your recommendation.
- `preference` — the user stated a standing preference or a recurring trade-off.
- `insight` — the user revealed a priority or reasoning.
- `refine` / `confirm` — minor; the tool will SUPPRESS these.

If the decision is project-specific (a repo convention, not a portable trait), set
`notes` to include "project-scoped" — it belongs in `CONTEXT.md`/ADR via
domain-modeling, not in portable memory.

## Discipline (inviolable)

- Memory only **informs** the recommendation. Never dump raw memory hits at the user.
- Always exactly **one recommendation** per question — the grilling contract.
- Do not call `grill_decision` before the user has answered, and never more than
  once per decision.
