# Ticket 02 — Esc interrupts a running foreground subagent

Status: done (PR pending, 2026-08-25 — investigation REVISED the scope; see
below. child-dispatch 27/0; full gates in the PR)

## Why

CC lets the user hit Esc while a subagent runs to interrupt it. s2-agent
appeared to have no display-surface interrupt for a FOREGROUND run (map
Context at charting time).

## Investigation (2026-08-25, ticket step 1) — the mechanism ALREADY exists

Measured in the pi dists on this machine:

- `app.interrupt` is DEFAULT-bound to `escape`
  (`pi-coding-agent/dist/core/keybindings.js:7` — "Cancel or abort").
- The editor routes Esc → `onEscape` → `interactive-mode.js:2219`: when
  `session.isStreaming`, it calls `agent.abort()` — aborting the running
  parent TURN, which aborts the in-flight subagent tool call.
- The tool seam passes the parent turn signal down
  (`subagent-tool.ts:462` `parentSignal: background ? undefined : signal`;
  background runs are deliberately decoupled, ADR-subagent-0007).
- The "(esc to interrupt)" hint already renders in the working status
  indicator while ANY turn streams (`interactive-mode.js:1741`).

So: claiming Esc ourselves (the ticket's original design) would COLLIDE
with pi's built-in — correctly dropped.

## The real gap (fixed here)

An Esc'd foreground run settled with a MISLEADING status: the parent signal
fans into the dispatch controller (`child-dispatch.ts:138-139`), the child
dies abort-shaped, and `classifyError` maps `signalAborted → kind:"timedout"`
(`spawn-subagent.ts:224-231`) — the old status fall-through
(`userAborted ? "aborted" : result.failure?.kind`) therefore badged an
Esc'd run **⏱ timedout** in the durable record and the /subagents viewer.

Fix (`child-dispatch.ts` status derivation): a non-detached run whose
dispatch-level controller aborted settles **`aborted`** regardless of WHICH
lever fired (viewer `x` or whole-turn Esc). `userAborted` keeps its strict
per-child meaning (child-only abort) — unchanged. A timeout never touches
the dispatch controller (its timer aborts the runner's controller inside
spawnSubagent), so `timedout` still derives from `result.failure` alone.
The spawn result's own failure kind is untouched.

## Scope (as executed)

1. `s2-agent-ext-subagent/src/child-dispatch.ts` — status derivation (above).
2. Tests (`tests/child-dispatch.test.ts`): the turn-level-abort case
   re-pinned (status `aborted`, `userAborted` still false) + a new pin that
   the REAL path (parent abort → spawn error carries `kind:"timedout"`)
   still settles `aborted` while the result keeps its own failure kind.
3. Ticket + map record the investigation (Esc ownership question resolved —
   see map Fog of war).

Not in scope (verified unnecessary or unchanged): any new key claim or
byte-sniff (collides with pi's built-in Esc); the per-line
`esc to interrupt` hint (pi's status indicator already carries it — adding
a per-line copy would duplicate it on every dispatch); background runs
(alt+decoupled by design; dock `x` covers abort).

## Done-when

- [x] Esc aborts an active foreground subagent — VERIFIED by code-path
      evidence (app.interrupt default Esc → agent.abort() → parentSignal →
      childAc; mechanism pre-existing) and the settle path is now pinned by
      tests (status `aborted`).
- [x] Esc passthrough when no subagent runs: no new key claim made — pi's
      own Esc semantics untouched; shortcut-guard unaffected (no
      registration added).
- [x] Canonical gates green (child-dispatch 27/0; package gate in the PR).
- [ ] PR merged CLEAN via the devops chain; map ticket flipped.
