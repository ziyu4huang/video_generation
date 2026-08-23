---
output: technical-review.pptx
theme: light
tag: technical review skeleton
defaults:
  font: PingFang TC
---
# Technical review — [the decision under review]
> One line: what is being reviewed, and who has to decide.

## 0 Agenda
### The review runs in four moves
:::agenda
{ "items": [ { "title": "Current state", "note": "facts first" }, { "title": "Options", "note": "two on the table" }, { "title": "Recommendation", "note": "one choice" }, { "title": "Risks", "note": "named, accepted" } ] }
:::
^ The agenda is the argument, written before the meeting.
~ [the review request or the calendar note]

## 1 Status quo
### The steady state stays right
- [the constraint the existing design satisfies, one line]
^ The status quo is the baseline to preserve, not the thing to change.
~ [the design note or benchmark that describes it]

## 2 Options
### Two options the team can actually hold
:::compare
{ "sides": [ { "heading": "Option A — keep the seams", "bullets": ["contains the change", "touches one module"] }, { "heading": "Option B — split the boundary", "bullets": ["isolates the hot path", "adds a new surface"] } ] }
:::
^ The real choice is which boundary the team will actually hold.
~ [ADR or spec section arguing the split]

## 3 Recommendation
### Option A ships, B stays documented
- [the contained deliverable, one line]
^ Ship A now, and record B in writing — a silent escape hatch is not a plan.
~ [the evidence set: tests, benchmarks, or the parity numbers]

## 4 Risks
### The lock-in is template precedence
- [the decision every future template inherits, one line]
^ Precedence is the risk; no template can override a code layout.
~ [ADR-archify-0001 or the registry docs]
