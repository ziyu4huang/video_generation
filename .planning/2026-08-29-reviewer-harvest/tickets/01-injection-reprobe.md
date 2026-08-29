---
type: task
status: open
---

# 01 — Re-probe claude CLI lead-inbox injection (live receipt)

## Question

Does the CURRENT claude binary (≥2.1.247, whatever is installed at
execution time) now inject child→lead inbox messages into the lead's turns
— promptly, delayed, or never?

## What to build

A live measurement, not code: record the installed claude CLI version;
dispatch a named probe subagent with a trivial 3-line task whose final step
sends a SendMessage to team-lead (mirroring the 2026-08-28 RCA probe);
watch the lead conversation for the notification at short intervals
(30s/60s/2m) while concurrently polling the subagent transcript on disk
for completion. Write the receipt (probe transcript path, completion time,
notification observed yes/no + delay, CLI version) into this ticket's
close-out and the effort map Context. Verdict line recorded: "injection
WORKS (<delay>) → notifications revert to primary" or "injection still
broken → harvest-primary stands" (D2's decision input).

## Acceptance

- [ ] CLI version + probe transcript path recorded; subagent completion
      verified on disk (timestamp).
- [ ] Notification observed/not-observed with watch duration recorded.
- [ ] One-line verdict recorded in the ticket close-out + map Context
      (drives t02's docs wording: primary vs fallback).
