---
effort: 2026-08-23-headless-dispatch-hang
created: 2026-08-23
last: 2026-08-23
status: active
---

# map — headless dispatch hang + arming gaps (live-smoke 2026-08-23 findings)

## Destination

Every headless `./s2-agent.sh -p` dispatch either completes and exits, or fails
within a bounded time — never hangs at 0% CPU with zero open sockets. Workflows
arming and budget directives work in headless mode exactly as documented in the
cc-parity-2 spec §2 (or the spec records the headless divergence deliberately).

## Context

Measured 2026-08-23 (17:00–18:10 local) on this machine, during the cc-parity-2
live-smoke batch (queue head of `output/next-goal-2026-08-23-152030.md`), model
`deepseek/deepseek-v4-flash`, this worktree at 452513a9.

**B1 — headless pre-send hang (blocker-class).** ~~pre-send hang~~ **CORRECTED
2026-08-23 evening: B1 and B3 are the SAME defect — a finished-but-never-exiting
`-p` run.** The "zero events before the first request" reading was an artifact
of bun's fully-buffered file-redirected stdout: the same "hung" invocation under
a pty completed its full event chain to `agent_settled` in ~1s. The prompt-shape
correlation (angle brackets 4/4) was noise from ~10 samples — the same prompts
passed 8/8 after the contention window. What remains true: healthy runs resolve
`main()` with an EMPTY active-resource list and exit in 3–5s; hang runs never
resolve `main()` (post-main instrumentation never executed); hang windows
coincided with concurrent deploy/E2E/probe s2-agent processes sharing `~/.pi`.
**Bounded** the same evening: `bun-apps/s2-agent/src/print-idle-watchdog.ts`
(print-mode stdout-idle deadline, default 300s, dumps active event-loop
resources + exit 2; post-`main()` grace exit 0 closes the lingering-handle
shape). Ticket 01 carries the full write-up. Original matrix kept for the
record:

| Prompt | Mode | Outcome |
|---|---|---|
| `reply with exactly: HARNESS-OK` (and 5 other short plain prompts) | full / bare | PASS 3–22s (6/6) |
| NATO-alphabet long plain prompt (~30 words, no punctuation) | bare | PASS 3s |
| `spawn_subagent(fork=true, prompt='say FORK-OK')` | bare | PASS 22s |
| same + `; print CHILD_REPLY: <its reply>` | bare | HANG 2/2 (>100s) |
| `reply with exactly: <hello world>` | bare | HANG |
| `print CHILD_REPLY: <its reply>` | bare | HANG |
| long weather paragraph (no tools, no brackets) | full | HANG (17:3x) |
| schedule_wakeup prompt (no brackets) | full | HANG 2/2 (18:0x) |
| full fork/smoke3 prompt | full | PASS at 17:00, HANG later — time/state component exists |

Exonerated by direct measurement: deepseek API (streaming + tools + 90KB
payload, 0.2–1.9s), LM Studio :1234 embeddings (30–50ms), surrealdb simple
queries (µs–ms), 429 rate limiting (12-burst all 200). SDK-retry-backoff was
considered and dropped: no sockets at all during bare-mode hangs.

**B2 — workflows arming + budget directive are interactive-only.**
`workflow-editor.ts:502` returns early unless `event.source === "interactive"`,
so a headless `-p` message containing `ultracode +500k …` never arms workflows
mode and the directive is never parsed. Measured: run `mt5msv81-dq40xz`
(persisted at `~/.pi/workflows/projects/video_generation__subagent-7b9ba1837451/runs/`)
completed with NO `tokenBudget`/`tokenBudgetSource` field, and the model called
`run_workflow` as an ordinary tool instead of the forced-workflow turn.

**B3 — post-settle linger (possibly B1-adjacent).** One run (plain foreground
spawn, full stack) completed the full event chain through `agent_settled` and
emitted its final answer, yet the process stayed alive ≥114s at 0% CPU before
being killed. Not reproduced since (m1–m4 settled-AND-exited in 20–34s).

**Live-smoke surface results** (recorded in
`.planning/2026-08-23-subagent-cc-parity-2/spec.md` §9): fork PASS, built-in
explore/plan PASS (read-only tools verified live, count cross-checked),
startup-context PASS (child reported the correct branch name), budget directive
measured-negative (B2), /loop dynamic BLOCKED by B1.

## Tickets

### Phase 1 — diagnose
- [x] `tickets/01-diagnose-preturn-hang.md` — B1=B3 corrected + BOUNDED:
  print-idle watchdog shipped (stdout-idle deadline + post-main grace exit);
  root cause narrowed to "`main()` never resolves under contention windows"
  (file:line still fog)
- [ ] `tickets/02-headless-arming-budget-directive.md` — B2: decide
  interactive-only vs headless support; implement or document the divergence (frontier)

## Decisions

- **D1 — ticket before code.** Per cc-parity-2 spec §7 and the queue head's
  step 2: defects found by live smoke get tickets in this effort BEFORE any
  code PR. All three findings (B1/B2/B3) landed here, not as drive-by fixes.
- **D2 — B1 is the effort's only blocker-class item.** B2 has a cheap
  workaround (don't rely on directives headless), B3 is unreproduced.

## Frontier

Ticket 02 (B2 headless arming + budget directive). B1 is bounded (watchdog
shipped); its root-cause chase resumes only when a recurrence prints the
`[print-idle-watchdog]` diagnostic. B2 is a small, self-contained decision +
one spec row.

## Fog of war

- B1's trigger predicate: CONTENT-INDEPENDENT (bracket correlation was sample
  noise); time-windowed, correlating with concurrent deploy/E2E/probe
  s2-agent processes sharing ~/.pi — causation unproven.
- B1's mechanism: `main()` never resolves (instrumented post-main code never
  ran during a hang); WHERE in main's await chain is unknown — the watchdog's
  stderr dump on the next recurrence is the designed capture path.
- Whether the pi SDK (0.84.2) or s2-agent's startup patches own the stall.

## Cross-effort links

- **Builds-on:** `.planning/2026-08-23-subagent-cc-parity-2/` — its live-smoke
  queue head surfaced all three findings; spec §9 carries the evidence rows.
