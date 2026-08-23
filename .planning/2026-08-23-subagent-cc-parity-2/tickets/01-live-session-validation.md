# Ticket 01 — live-session validation + live-agent memory measurement

Status: done (2026-08-23) · Phase 1 (gates tickets 02–04)

## Scope

De-fog the teams-parity effort in a real interactive session and measure what
N live in-process child sessions cost. Two deliverables:

1. **Live-TUI smoke** of teams-parity tickets 01–05 surfaces — the surfaces
   that shipped 2026-08-22..23 without ever running in a live session.
2. **Memory harness** spawning K = 1..6 named live agents (the
   `SUBAGENT_MAX_LIVE` LRU cap) and sampling `process.memoryUsage()` before/
   after each, reporting per-session marginal cost and the LRU eviction delta.

## Smoke script (manual, in a real terminal)

Run `./s2-agent.sh` from the repo root. Record pass/fail per step in the
`## Smoke log` section below (or in the PR description if the ticket closes
before the log is filled):

1. Ask the model to `spawn_subagent` with `name: "smoke-a"` and a trivial
   read-only task. Observe the tool render and that the run completes.
2. "send smoke-a a follow-up asking what it just did" — `send_message` routes
   by name; the reply surfaces in the parent.
3. `/subagents` — the roster row for smoke-a shows live/completed state.
4. Spawn a second named child `smoke-b`, then "ask smoke-a to send smoke-b a
   message" — observe the parent-brokered relay (teams-parity ticket 05) in
   `/subagents`.
5. "ask smoke-b to request plan approval for X" — observe the parent-side
   decision prompt and the DENY-on-timeout path.
6. `list_subagent_runs list` — the live roster section renders.

Any failure is either fixed in this ticket (if small) or becomes a blocking
fog entry in map.md.

## Memory harness

- New `bun-apps/s2-agent-ext-subagent/tests/memory-live-agents.test.ts`,
  guarded `test.skipIf(!process.env.S2_MEM_PROBE)` so CI never pays for it.
  Run: `S2_MEM_PROBE=1 bun test tests/memory-live-agents.test.ts`.
- Uses the real live-agent open path via `persistent-agent.ts`'s injectable
  runner seams (same pattern as `tests/named-live-agent.test.ts`) with a fake
  transport (zero API spend — measures session-object overhead only; say so
  in the log).
- Samples `process.memoryUsage().rss` + `external` at K=0..6 and after forced
  LRU eviction; prints a table. Assert only structural facts (loose monotonic
  bound, registry length cap) so it cannot flake on GC — the NUMBERS are
  logged, not asserted.

## Files

- New: `bun-apps/s2-agent-ext-subagent/tests/memory-live-agents.test.ts`
- Maybe: a small test-helper export from `src/persistent-agent.ts` if a seam
  is missing
- map.md Fog-of-war resolution + spec.md §3 (memory evidence) — same PR

## Memory log (measured 2026-08-23, this machine)

`S2_MEM_PROBE=1 bun test tests/memory-live-agents.test.ts` (ext-subagent),
faux transport — session-object overhead only, as scoped above:

```
K=0 (post-warmup baseline)         rss= 151.0MB  heapUsed=  24.1MB  external=   8.3MB
K=1                                rss= 151.2MB  heapUsed=  24.2MB  external=   8.3MB  (+0.2MB)
K=2                                rss= 151.3MB  heapUsed=  24.3MB  external=   8.4MB  (+0.3MB)
K=3                                rss= 151.5MB  heapUsed=  24.4MB  external=   8.5MB  (+0.5MB)
K=4                                rss= 151.5MB  heapUsed=  24.5MB  external=   8.6MB  (+0.5MB)
K=5                                rss= 151.5MB  heapUsed=  24.5MB  external=   8.6MB  (+0.5MB)
K=6                                rss= 151.8MB  heapUsed=  24.6MB  external=   8.7MB  (+0.8MB)
K=post-evict (7th opened, 1st out) rss= 151.8MB  heapUsed=  24.6MB  external=   8.7MB  (+0.8MB)
```

Readings: marginal ≈0.1–0.2MB RSS per live session; LRU eviction returns the
session to GC without shrinking process RSS. Structural asserts (registry cap,
eviction victim, faux-reply exchange) all green; skip-path green without the
env (1 pass + 1 skip).

**Harness seam fix shipped with the ticket** (`sessionModelInjectionWins` in
core-runtime `agent-model.ts`): on tier-configured machines the untagged
default-medium branch resolved a tier model through the REAL registry and
silently overrode a caller-injected `session: {model}` — the harness's faux
model never took effect (first probe run replied from the real LM Studio
default, ~10s/exchange, and the real child even wrote an entry to the
hermes-memory vault, since removed). Any `session: {model}` injection
(file2md-style vision models included) was defeated the same way; injection now
wins whenever no per-call `model`/`tier` is given.

## Smoke log (2026-08-23, this machine)

Headless single-session smokes via `./s2-agent.sh --model
deepseek/deepseek-v4-flash -p` (a live agent is in-process, so all
addressability steps ran in ONE session per round; LM Studio was engine-jammed
that day — see the session notes — so the smoke ran on the deepseek provider).
Three rounds; final round **6/6 PASS**:

1. spawn `smoke-a` (named, live) — **PASS** (rounds 1+3; run ids recorded,
   e.g. `mt56fv0x-idrm6s`).
2. `send_message` follow-up to smoke-a — **PASS** (re-prompt of an idle live
   agent surfaced the reply in the parent).
3. `/subagents` roster row — **not headless-verifiable** (TUI viewer; needs a
   real terminal session — recorded as accepted limitation, not automated
   theater, per Risks). The same roster data rendered correctly through
   `list_subagent_runs list` (step 6).
4. spawn `smoke-b` + parent-brokered a→b relay — **PASS** (round 3, after the
   bridge fix below: smoke-a's child-side `send_message` delivered to smoke-b).
5. smoke-b `request_plan_approval` + DENY-on-timeout — **PASS** (round 3):
   the request surfaced at the parent as a plan_approval_request notification;
   the child's synchronous tool call resolves **default-deny after its 5s
   window**, BEFORE a parent verdict can round-trip — the effective semantics
   are "parent must answer within the child's timeout". A late
   `plan_approval_response` is a clean no-op ("No pending plan approval…").
   Also confirmed: the response must target the requesting child's name
   (`to: "smoke-b"`), never `main`.
6. `list_subagent_runs list` live roster — **PASS** (rows for both named
   runs; live roster correctly empty after budget-terminations in round 1).

### Findings (fixed or fogged by this ticket)

- **F1 (FIXED): every spawned child lost ALL parent extension tools.** Rounds
  1–2: children (named AND unnamed one-shot) saw only read/bash/edit/write —
  no `send_message`, no `request_plan_approval`, no obsidian/devops tools.
  Root cause: since pi-coding-agent 0.84.2, `createExtensionAPI` returns a
  FIXED-SHAPE delegation object (never spreads the runtime), so the
  ext-api-get-all-tool-definitions runtime patch's `runtime.getAllToolDefinitions`
  is INVISIBLE on the `pi` object — every `pi.getAllToolDefinitions?.()`
  capture silently returned undefined. Fix: the patch now ALSO publishes the
  reader on a globalThis key; `@repo/s2-agent-core-interface` gains
  `readAllToolDefinitions()` (api first, global fallback); ext-subagent reads
  it LAZILY at spawn time (session_start one-shot capture also retained);
  ext-ultracode heals at before_agent_start (same dead capture);
  ext-knowledge-card's identical dead capture switched to the helper.
- **F2 (fog → follow-up): default lifetime tokenBudget (120k) is too tight
  for big-context children.** Round 1: a named child burned 164k tokens on
  two trivial exchanges (large system prompt + tools counted per-turn,
  cumulative stats) and was terminated mid-conversation — the relay and
  plan-approval steps died on BUDGET, not protocol. Round 3 with
  `tokenBudget: 2000000` passed clean. Needs a decision (raise the live-agent
  default? count non-cache tokens only?) — recorded in map Fog of war; folds
  into ticket 05's budget work.
- **F3 (context): LM Studio was engine-jammed** (idle CPU, no new requests
  served for 39+ min, dist session occupying the queue) — the smoke moved to
  deepseek-v4-flash; nothing to fix in-repo, but it invalidated the
  "oneshot-smoke deepseek 401" note from the planning session: the key works
  as of 2026-08-23.

## Risks

- TUI-only behavior (viewer rendering) cannot be asserted headless — the smoke
  log is manual evidence by design; do not automate it into theater.
- Memory numbers vary by model/transport; the fake transport bounds what is
  being claimed.

## Verification

- `bun test tests/memory-live-agents.test.ts` passes WITHOUT the env (skip
  path asserted) and prints the table WITH it.
- Canonical gates stay green: `( cd bun-apps/s2-agent-ext-subagent && bun run
  check && bun run typecheck && bun test )` — and, per the learned systemic
  gap (teams-parity fog), run the full gate list for s2-agent-core-runtime and
  s2-agent-ext-ultracode too, regardless of diff scope.
- Smoke log filled; findings recorded in map.md + spec.md.
