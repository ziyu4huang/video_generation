# t02 — Env honesty: SurrealDB-gated suites skip LOUDLY with a count

Status: open · Phase 2 · Needs: t01 · Blocks: t04

## Goal

When the local SurrealDB (127.0.0.1:8000) is unreachable, the suites that need
it SKIP VISIBLY — bun-test skip counts + a one-line summary — instead of the
current silent early-return pass-through (arc-17 auditor note b; map D4).
With the server up, behavior is unchanged: everything runs, 0 skips.

## Steps

1. Read the precedent FIRST — do not invent a mechanism: 
   `bun-apps/s2-agent/src/env-flag.ts` and `__tests__/e2e-harness.ts`
   (PI_AGENT_E2E, cited at env-flag.ts:7). If the pattern extends to ext
   packages, mirror it (flag naming, skip idiom, summary shape). If it does
   not, use the same SHAPE locally (an env flag consulted by the live-backend
   test harness) and record why in Resolution.
2. Locate the current silent gate (candidates: `src/store/repository.ts`,
   `src/store/backend-factory.ts`, the live-backend test harness — grep for
   the health/8000 check). Map EVERY suite/file that consults it — the
   inventory goes in Resolution (this answers the auditor's "no signal how
   many live-backend tests actually exercised").
3. Convert the silent path to explicit skips with a reason string, so bun
   test reports a skip COUNT, e.g. `test.skip("SurrealDB live backend
   unavailable at 127.0.0.1:8000 — start it to run this suite")`. No
   early-return green. One summary line per run (a single console.log from
   the harness, not per-test spam): "N live-backend tests skipped".
4. Verify BOTH directions (receipts in Resolution):
   - Server UP: full pass, skip count 0, suites run (numbers comparable to
     the 1564-pass baseline).
   - Server DOWN: exit 0, skip count > 0 and visible, summary line printed,
     zero silent pass-throughs. Then RESTORE the server (health 200) — do
     not leave the environment degraded.
5. If (and only if) this required a `src/` change, flag it for t04: the
   devops chain must then include redeploy + qualify sweep (map D6). Record
   the file list.

## Acceptance

- Server-down run shows a nonzero, visible skip count + the summary line;
  server-up run is the normal green with 0 skips. Both receipts recorded.
- No test that needs the live backend can pass green while the backend is
  down (grep-level proof: no early-return-on-unreachable path remains).
- If src/ changed: MEMORY_TOOL_DESCRIPTION still byte-identical; redeploy
  flagged to t04.
