---
type: task
blocking: 01
status: closed
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

- [x] `scripts/` entry + `src/` lib, throw-free JSON contract, `--help`
      documented, scripts-dir-contract allowlist row added.
      (`scripts/reviewer-harvest.ts` + `src/reviewer-harvest.ts`; exit
      0 completed / 1 still-running·absent·errored / 2 usage; allowlist
      row in `tests/scripts-dir-contract.test.ts`.)
- [x] Unit tests green over fixture transcripts covering newest-selection,
      name match, verdict extraction, still-running/absent/errored states,
      receipt writing. (`tests/reviewer-harvest.test.ts`, 21 tests incl.
      scripts-dir contract — fixtures copied from the real t01 probe
      transcript + the real 429 death shape; full devops `bun run test`
      1030 pass + `tsc --noEmit` clean + local-ci green 2026-08-29.)
- [x] One live receipt: run against a real dispatched reviewer transcript
      (can be t01's probe) and record the harvest output in the close-out.
      (Live 2026-08-29: `--name injection-probe` → status completed, verdict
      `INJECTION-PROBE-MARKER-Movie Director…`, SendMessage record captured,
      receipt `output/reviewer-harvest/injection-probe-e4fa0b0d.json`,
      exit 0; immediate re-run → `unchanged: true` — idempotence proven
      live, not just in fixtures.)
