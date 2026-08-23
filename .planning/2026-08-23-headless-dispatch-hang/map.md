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

**B1 — headless pre-send hang (blocker-class).** With `--no-session --mode
json -p <prompt>`, the process intermittently-but-content-keyed hangs BEFORE the
first model request: zero JSON events, 0% CPU, zero TCP connections (lsof,
repeated sampling — no deepseek connection exists, so the request is never
sent), main thread in `kevent64` (sample). Reproduces in BARE mode
(`--no-extensions --no-skills`) → the blocker is in the core pi loop or the
s2-agent startup patches, not extensions/skills. Evidence matrix:

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
- [ ] `tickets/01-diagnose-preturn-hang.md` — B1: localize the content-keyed
  pre-send await in the core loop; fix or bound it (active)
- [ ] `tickets/02-headless-arming-budget-directive.md` — B2: decide
  interactive-only vs headless support; implement or document the divergence

## Decisions

- **D1 — ticket before code.** Per cc-parity-2 spec §7 and the queue head's
  step 2: defects found by live smoke get tickets in this effort BEFORE any
  code PR. All three findings (B1/B2/B3) landed here, not as drive-by fixes.
- **D2 — B1 is the effort's only blocker-class item.** B2 has a cheap
  workaround (don't rely on directives headless), B3 is unreproduced.

## Frontier

Ticket 01 (B1 diagnosis). It is first because it blocks headless dispatch
reliability — the exact lane the cc-parity-2 live smoke, the oneshot-smoke CI
gate (trivial prompts only, which is why it never caught this), and the deploy
E2E all depend on, and it blocks the /loop-dynamic surface measurement.

## Fog of war

- B1's exact trigger predicate: angle brackets correlate 4/4, but the
  bracket-free schedule_wakeup prompt hung 2/2 and a bracketed prompt passed at
  17:00 — there is a time/state component not yet identified.
- B1's mechanism: 0% CPU + zero sockets + kevent64 = an await on a
  timer/event that never fires. Where in the core loop is unknown.
- B3's relationship to B1 (same await class post-turn?) is unknown.
- Whether the pi SDK (0.84.2) or s2-agent's startup patches own the bug.

## Cross-effort links

- **Builds-on:** `.planning/2026-08-23-subagent-cc-parity-2/` — its live-smoke
  queue head surfaced all three findings; spec §9 carries the evidence rows.
