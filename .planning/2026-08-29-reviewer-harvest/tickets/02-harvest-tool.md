---
type: task
blocking: 01
status: open
---

# 02 — reviewer-harvest CLI: poll, extract, receipt

## Question

Can the validated harvest SOP become one throw-free repo command that any
session runs right after dispatching a named reviewer subagent?

## What to build

The productization: a devops-style headless CLI (lib in `src/`, runnable
entry in `scripts/` per the scripts-dir contract, JSON on stdout, exit
0/1/2, `--help`) that takes the reviewer's dispatched NAME (plus optional
`--harness-root` defaulting to `~/.claude-glm`, and `--timeout`/`--poll`),
locates the NEWEST matching subagent transcript
(`.../subagents/agent-a<name>-<hash>.jsonl`) under the harness projects
dir, waits for its final assistant text (distinguishing still-running from
absent from errored), extracts that text as the verdict, and writes a
receipt file (transcript path + verdict + dispatch/harvest timestamps +
harness root) under the repo's `output/` area. Unit tests over fixture
transcripts (real RCA shapes: thinking blocks, tool trail, last assistant
text) pin: newest-selection, name matching, verdict extraction, the three
terminal states, receipt contents + idempotence. The dispatch itself stays
with the session's Agent tool — this tool owns everything after.

## Acceptance

- [ ] `scripts/` entry + `src/` lib, throw-free JSON contract, `--help`
      documented, scripts-dir-contract allowlist row added.
- [ ] Unit tests green over fixture transcripts covering newest-selection,
      name match, verdict extraction, still-running/absent/errored states,
      receipt writing.
- [ ] One live receipt: run against a real dispatched reviewer transcript
      (can be t01's probe) and record the harvest output in the close-out.
