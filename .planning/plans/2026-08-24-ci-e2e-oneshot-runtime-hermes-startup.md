# CI E2E — bound one-shot runtime + hermes-memory startup speed

Status: done 2026-08-24 — budgets landed in the deploy-e2e model-call probe
(`bun-apps/s2-agent-ext-devops/src/deploy-e2e-recipe.ts`:
`ONESHOT_RUNTIME_BUDGET_MS = 35_000`, `HERMES_STARTUP_ROUNDTRIP_CAP = 150`).
Baseline provenance (measured 2026-08-24 on this machine, deployed
`0.7.1+gd6f3c0c` — i.e. main WITH the #1976 fix, so these are the post-fix
numbers, not the plan's original 12.3s): one-shot wall 10.97–10.99s over 8
runs (p95 10.99s) → budget 35s = 3.2× headroom, BELOW the 36.6s #1976
regression so that class fails; contention (>1 large resident model via the
existing precheck) downgrades a wall breach to SKIP. hermes
syncMarkdownMemories round-trips: 103–114 dirty-vault (breach banner) / 26
clean (610ms, below the extension's 50-RT threshold — visible only via
`PI_HERMES_PERF=1` full trace) → cap 150 on the stderr banner, absent banner
= under the extension's own thresholds = pass. Live verification:
`verify-deploy-e2e-cli` against `current` → pass, model-call note
`ok — wall 11.0s (budget 35s)`. Unit coverage: 5 budget tests +
5 `parseHermesStartupRoundTrips` tests in `tests/verify-deploy-e2e.test.ts`
(devops suite 881 pass / 0 fail). The fix itself (batch the surrealdb
session) remains the successor goal — this is the CONTROL only.

## Problem (measured 2026-08-24, this machine)

```
$ time ~/proj/video_generation__deploy/s2-agent.sh --model deepseek-v4-flash-vision-exp:off -p "write ~/hello.md "
[hermes-memory] slow startup.syncMarkdownMemories: 104 HTTP round-trips (backend=surrealdb). See perf.jsonl.
Wrote `/Users/huangziyu/hello.md` (23 bytes).
1.09s user 0.65s system 14% cpu 12.262 total
```

A trivial one-shot prompt takes **12.3 s wall** at **14% CPU** — the time is
not compute, it is startup serialization (dominated by hermes-memory's
`syncMarkdownMemories`: 104 HTTP round-trips against the surrealdb backend;
the same count measured as 114 and 103 in adjacent sessions). Nothing in CI
controls either number today, so they regress silently.

## Ticket

Add a CI E2E lane that FAILS on regression of:

1. **One-shot runtime** — `s2-agent.sh -p` trivial prompt completes within a
   bounded wall time (budget from a measured baseline, e.g. p95 of N runs;
   generous enough for model contention, tight enough to catch a 2× drift).
2. **hermes-memory startup** — the round-trip count / duration reported by the
   slow-startup banner (and `perf.jsonl`) stays under a cap.

### Approach notes

- Runtime probe belongs beside the existing deploy e2e family
  (`verify-deploy-e2e-cli.ts` already boots the deployed launcher with
  bounded caps — reuse `createLiveSpawn` + `withDefaultTimeout`).
- The hermes round-trip fix itself (batch the surrealdb session) is the
  successor next-goal ranked entry "hermes-memory startup perf"; this ticket
  is the CONTROL (the gate that keeps any fix from regressing), not the fix.

## Done when

- [x] A CI-gated test asserts one-shot wall time under the measured budget
- [x] A CI-gated test (or the same one) asserts hermes startup round-trips
      under a cap, reading the banner/perf.jsonl the extension already emits
- [x] Both documented in the effort map / successor notes with the baseline
      numbers they were set from
