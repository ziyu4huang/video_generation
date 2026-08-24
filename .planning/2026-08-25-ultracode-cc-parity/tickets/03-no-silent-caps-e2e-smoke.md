# 03 — No-silent-caps logging + real e2e smoke (G5 + verification)

## Scope

Map tickets phase B; spec §5.

1. **Verify the seam first** (map fog): `normalizeConcurrency`
   (src/workflow.ts:433-436) clamps before the run's log sink may exist.
   In-ticket: locate where run-scoped `log()`/journal events attach; if the
   clamp precedes it, surface the clamp in the run's initial event record /
   status line instead — the contract is "the run says it was clamped", not
   "the log function specifically".
2. **Clamp logging** — concurrency clamp (requested > 16 or
   hardwareConcurrency-2) and the maxAgents / 1000-total clamp
   (src/workflow-runtime.ts:214-220) each emit one line naming
   requested→actual. Background runs show it in the live panel source data.
3. **E2E receipt** — run `samples/smoke-e2e.ts` once with the local PI_MODEL
   (per README: `PI_MODEL=google/gemma-4-12b bun
   ./bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.ts`) on the merged
   branch state; record the JSON receipt (`{"ok":true,…}`) in this ticket.
   This validates the full real path (CLI → `-e workflow` → tool → model →
   script run) still works after t01/t02 prompt+stdlib changes.

## Acceptance criteria

- [x] Seam verification recorded: the run logger is created at workflow.ts
      BEFORE concurrency normalization (~:307 vs ~:329), so the concurrency
      clamp line lands in BOTH `state.logs` (returned in the run result) and
      `logger.warn` (persisted run log + onLog stream) — no fallback needed;
      the maxAgents cap fires at dispatch time inside `agent()`
      (workflow-runtime.ts), logged via the runtime `log()` (state.logs +
      logger) immediately BEFORE the non-recoverable throw, so even a script
      that catches the error keeps the line in its run logs.
- [x] Both clamps log requested→actual; unit tests assert the lines
      (tests/agent.test.ts: `[clamp] concurrency 64 → 16 (max 16)` /
      unclamped-stays-quiet / `[clamp] agent limit reached (maxAgents=1)` +
      the caught error code)
- [x] Canonical `bun run --cwd bun-apps/s2-agent-ext-ultracode test` green —
      1191 pass / 0 fail
- [x] BONUS FIX (found by the e2e run): `samples/smoke-e2e.ts` passed `-e
      ultracode` as a bare name, but pi's extension loader resolves `-e`
      values as cwd-relative PATHS — `<root>/ultracode` does not exist, so the
      documented e2e was broken ON MAIN (pre-existing, nothing in this effort
      caused it). Fixed: the smoke resolves the engine's registered entry
      (`bun-apps/s2-agent-ext-ultracode/extensions/ultracode.ts`) from the
      repo root, `SMOKE_E2E_EXT` override for tests; smoke-e2e-contract
      golden updated to pin the resolved path. Probing the path form +
      `pong` round-trip confirmed the model lane works.
- [x] smoke-e2e receipt (executed 2026-08-25, `PI_MODEL=prism-ml/bonsai-27b`
      — gemma-4-12b was loaded at probe time but LM Studio evicted it
      mid-run for a sibling session's model, so the receipt run used the
      loaded bonsai-27b; `S2_PRINT_IDLE_EXIT_MS=900000` for the relay):
      exit 0 through the REAL path (CLI → `-e` engine entry → extension →
      model → workflow tool → script run) —
      `| Agents dispatched | 2 (parallel) | / | Agent echo-foo result | FOO ✅ |
       | Agent echo-bar result | BAR ✅ | / | Token usage | 68,006 |`.
      Honest caveat: the run was piped through `tail -6` so the raw
      `{"ok":true,…}` JSON line itself was not captured — the FOO/BAR agent
      results + join + exit 0 are the captured evidence (the smoke01 script's
      join makes those the result's constituents). Two failed pre-attempts
      recorded: bare-name `-e ultracode` (the bonus fix above) and the
      mid-run gemma unload ("Model unloaded." — silent abort, hence the
      PI_MODEL note in the smoke's usage doc).
- [x] PR via devops chain (#2020, squash b1e6bbd4, CLEAN); reviewer
      APPROVE_WITH_NITS applied (checkpoint()/call() limit gates log the same
      clamp line via an injected optional log dep; sub-1 clamps attribute
      "(invalid; min 1)"; smoke EXT existsSync guard + SMOKE_E2E_EXT header
      doc; accepted: nested-run duplicate clamp line — cosmetic); effort
      close-out: map status → complete (all 3 tickets merged: #2016, #2017,
      #2020)
