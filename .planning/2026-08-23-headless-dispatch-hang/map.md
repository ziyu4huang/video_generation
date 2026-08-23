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

**B2 — workflows arming + budget directive are interactive-only.** ~~The
`workflow-editor.ts:497` source guard blocks headless.~~ **RE-DIAGNOSED
2026-08-23 evening (ticket 02, done): the guard does NOT block print mode** —
upstream print-mode `prompt()` passes no `source` and `AgentSession.prompt`
defaults the input event to `"interactive"`, so the arming transform runs
headless. The smoke's negative (run `mt5msv81-dq40xz`, no
`tokenBudgetSource`) was caused by `keywordTriggerEnabled: false` in this
machine's global `~/.pi/workflows/settings.json` — keyword arming off
EVERYWHERE, interactive included. A/B measured live in a scratch project:
trigger on → forced-workflow preamble in the headless transcript, run
`mt5q0urv-9hdejl` persists `tokenBudget: 500000, tokenBudgetSource: "merged"`;
trigger off → raw message, run `mt5pwx3c-30sjnp` persists `"model"` (the model
improvised the budget from the raw text). Parity pinned deterministically by
`s2-agent-ext-ultracode/tests/headless-arming-parity.test.ts` (faux
AgentSession + the exact print-mode call shape).

**B3 — post-settle linger (possibly B1-adjacent).** One run (plain foreground
spawn, full stack) completed the full event chain through `agent_settled` and
emitted its final answer, yet the process stayed alive ≥114s at 0% CPU before
being killed. Not reproduced since (m1–m4 settled-AND-exited in 20–34s).

**B4 — colliding command name `loop` breaks slash dispatch via `prompt()`
(found by the `/loop dynamic` live smoke, 2026-08-23 evening; ticket 03).**
ext-task and ext-ultracode BOTH `registerCommand("loop")`; the SDK suffixes
both to `loop:1`/`loop:2`, `getCommand("loop")` finds neither, so a `-p
'/loop …'` dispatch falls through to the MODEL as literal text (measured: raw
string in the transcript + runaway exploration, watchdog-bounded at 300s).
The original cc-parity-2 §9 "BLOCKED (B1)" row for `/loop` dynamic is this
defect plus B1. The `schedule_wakeup` TOOL half is healthy headless (model
called it, correct no-active-loop text, clean exit 0); single-name command
dispatch verified fine in a faux control. Repo's only collision (scanned all
ext `registerCommand` names).

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
- [x] `tickets/02-headless-arming-budget-directive.md` — B2 RESOLVED as
  "verify + pin": the interactive-only premise was wrong (print-mode input
  events default to source "interactive"); the smoke negative was the
  machine's `keywordTriggerEnabled: false`. Headless parity measured live
  (runs `mt5q0urv-9hdejl` merged / `mt5pwx3c-30sjnp` model) and pinned by
  `tests/headless-arming-parity.test.ts`; spec §2 + §9 rows corrected in the
  same PR
- [ ] `tickets/03-colliding-command-name-breaks-slash-dispatch.md` — B4: the
  `loop` name collision (ext-task + ext-ultracode) makes `getCommand("loop")`
  miss so headless `/loop …` falls to the model; choose fix (patch fallback /
  rename / upstream), pin with a test, re-run the live smoke (frontier)

## Decisions

- **D1 — ticket before code.** Per cc-parity-2 spec §7 and the queue head's
  step 2: defects found by live smoke get tickets in this effort BEFORE any
  code PR. All three findings (B1/B2/B3) landed here, not as drive-by fixes.
- **D2 — B1 is the effort's only blocker-class item.** B2 has a cheap
  workaround (don't rely on directives headless), B3 is unreproduced.
  (D2's premise about B2's workaround aged out — B2 turned out not to be a
  headless gap at all; see D3.)
- **D3 — B2 resolved as verify + pin, not extend (ticket 02).** The
  interactive-only reading was a misdiagnosis: the SDK's print-mode `prompt()`
  defaults the input event to source "interactive", so the workflow-editor
  guard never blocked headless; the smoke's measured negative was this
  machine's `keywordTriggerEnabled: false`. Shipped a deterministic parity
  test (faux AgentSession over the print-mode call shape) + spec §2/§9
  corrections rather than a guard change. Corollary: live arming-by-keyword
  requires the trigger enabled (per-project or global) — mode-independent.

## Frontier

Ticket 03 (B4 colliding command name). Small and self-contained: pick the fix
approach, implement + test, re-run the `/loop dynamic` live smoke. B1's
root-cause chase stays event-driven (recurrence prints the
`[print-idle-watchdog]` diagnostic).

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
