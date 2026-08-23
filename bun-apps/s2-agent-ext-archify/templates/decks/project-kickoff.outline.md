---
output: project-kickoff.pptx
theme: light
tag: project kickoff skeleton
defaults:
  font: PingFang TC
---
# Project kickoff — [initiative name]
> One line: the outcome this team will be accountable for.

## 1 Goal
### The outcome is [one metric]
- [the metric, one line]
- [the threshold that counts as done]
^ The goal is the outcome; the deliverables are how it is measured.
~ [the charter or the decision that picked the metric]

## 2 Scope
### The fence: we do [X], we do not do [Y]
- [in-scope, one line]
- [out-of-scope, one line]
^ The fence is what makes the estimate defensible.
~ [the stakeholder note or the product decision]

## 3 Milestones
### Three stations, not thirty
:::timeline
{ "milestones": [ { "date": "M1", "label": "Design agreed", "note": "sign-off in writing" }, { "date": "M2", "label": "First vertical slice", "note": "one happy path" }, { "date": "M3", "label": "Pilot in the room", "note": "with real users" } ] }
:::
^ Three stations, not thirty — a milestone you cannot name is not a milestone.
~ [the plan or the effort map it came from]

## 4 Owners
### One owner per area
:::table
{ "columns": ["Area", "Owner", "By"], "rows": [ ["Design", "[name]", "M1"], ["Build", "[name]", "M2"], ["Evaluation", "[name]", "M3"] ] }
:::
^ One owner per area; shared responsibility is nobody's responsibility.
~ [the roster or the RACI that names each one]

## 5 Next
### The first week is [the small step]
- [the one small step, one line]
^ Start by unblocking [the one dependency], not by scheduling the review.
~ [the ticket or the calendar entry that proves the start]
