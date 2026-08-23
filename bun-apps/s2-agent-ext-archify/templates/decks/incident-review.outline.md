---
output: incident-review.pptx
theme: light
tag: incident review skeleton
defaults:
  font: PingFang TC
---
# Incident review — [incident title, the date it cost]

## 1 Timeline
### The timeline is the fact sheet
:::timeline
{ "milestones": [ { "date": "09:58", "label": "First alert", "note": "10% of requests failed" }, { "date": "10:21", "label": "Mitigation applied", "note": "manual failover" }, { "date": "10:54", "label": "Back to normal", "note": "pager released" } ] }
:::
^ The timeline is the fact sheet; it is what the rest must explain.
~ [the alert log or the on-call handoff]

## 2 Impact
### Impact is measured, not felt
:::kpi-row
{ "kpis": [ { "value": "[N] min", "label": "time to mitigate", "note": "vs [M] target" }, { "value": "[N]%", "label": "users affected", "note": "measured, not guessed" } ] }
:::
^ Impact is the number the room owns; it is never a narrative.
~ [the dashboards or the billing record that measures it]

## 3 Root cause
### The cause was [mechanism], not [intent]
- [the mechanism, one line]
^ Name the mechanism; motives are a different, cheaper story.
~ [the code or config diff at the failure point]

## 4 Mitigation
### What got it back up was [action]
- [the action, one line]
^ The fix is not done until the manual step is optional.
~ [the follow-up ticket that automates the failover]

## 5 Follow-up
### It ends in tracked actions
:::end
{ "headline": "Three actions, one owner each, next review date [date]", "contact": "[owner slot in the tracker]" }
:::
~ [the issue tracker or the chart of open items]
