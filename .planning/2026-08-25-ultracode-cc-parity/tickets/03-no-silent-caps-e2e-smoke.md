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

- [ ] Seam verification recorded (where the clamp lines land and why)
- [ ] Both clamps log requested→actual; unit test asserts the line(s)
- [ ] Canonical `bun run --cwd bun-apps/s2-agent-ext-ultracode test` green
- [ ] smoke-e2e receipt (ok:true JSON) pasted in this ticket
- [ ] PR via devops chain; reviewer pass; effort close-out check (map status
      → complete if all tickets merged)
