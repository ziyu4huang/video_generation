# CI E2E — bound one-shot runtime + hermes-memory startup speed

Status: open · seeded 2026-08-24 (user ask, mid registry-code-as-config t03 session)

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

- [ ] A CI-gated test asserts one-shot wall time under the measured budget
- [ ] A CI-gated test (or the same one) asserts hermes startup round-trips
      under a cap, reading the banner/perf.jsonl the extension already emits
- [ ] Both documented in the effort map / successor notes with the baseline
      numbers they were set from
