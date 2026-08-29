---
type: task
status: done
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

- [x] CLI version + probe transcript path recorded; subagent completion
      verified on disk (timestamp). — CLI **2.1.250** (RCA baseline was
      2.1.247); transcript
      `~/.claude-glm/projects/-Users-huangziyu-proj-video-generation--subagent/3159f201-3f88-452f-9936-6d7af675c0b5/subagents/agent-ainjection-probe-c27137ca99032335.jsonl`
      (18 KB, 8 lines, mtime 2026-08-29 08:01): SendMessage to main with
      `INJECTION-PROBE-MARKER-Movie Director` + the marker as final text —
      task completed correctly.
- [x] Notification observed/not-observed with watch duration recorded. —
      **OBSERVED**: the `<agent-message from="injection-probe">` block was
      injected into the LEAD conversation ≤ ~45s after dispatch (arrived
      during the first 40s watch-poll), while the lead was mid-turn in a
      Bash call — exactly the injection the RCA never saw on 2.1.247.
- [x] One-line verdict recorded in the ticket close-out + map Context
      (drives t02's docs wording: primary vs fallback). — **VERDICT:
      injection WORKS on 2.1.250 (≤45s observed) → NOTIFICATIONS REVERT TO
      PRIMARY; the harvest tool (t02) remains the fallback + durable
      receipt writer, and the fallback stays one command away for any
      regression.** Caveat: single probe, prompt-shape; the >24h-delay
      mode the RCA amended would not show in a 45s window — t03's
      closeout-SOP inbox re-read stays valuable either way.
