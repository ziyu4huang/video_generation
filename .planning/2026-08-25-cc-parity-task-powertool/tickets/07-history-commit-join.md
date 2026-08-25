# Ticket 07 — History commit-boundary join (sidecar ↔ transcript)

Status: pending

## Why

The environment sidecar records `gitSha` per session precisely so trends
can answer "did my change regress behavior at a commit boundary"
(sidecar.ts:35) — but `SessionScan` carries no sessionId (scan.ts:62-75),
so the sidecar↔transcript join is impossible even by hand, `readSidecar`
has zero non-test consumers, and windows are session-count buckets only.

## Scope

1. **sessionId in SessionScan**: extract from the `session` event or the
   `<timestamp>_<uuid>.jsonl` filename (scope.ts:5-13 documents why cwd
   comes from content, never the filename — sessionId may safely come from
   either; prefer the event, fall back to the filename).
2. **Join**: agent-trends loads the sidecar and joins scans by sessionId;
   sessions without a sidecar line (crash before write, older history)
   render as `sha:unknown` and never drop out of the denominator.
3. **Segmentation**: `--since-sha <sha>` / `--before-sha <sha>` flags
   segment windows by the session's recorded sha (git topology via
   `git merge-base --is-ancestor`; unknown shas — e.g. rebased away —
   render unknown and are excluded from BOTH sides, loudly counted).
4. **Report**: segmented output shows per-segment occurrence rates side by
   side, consuming ticket 06's verdict math (this is why 06 → 07).
5. Tests: join correctness (match/mismatch/missing sidecar), segmentation
   boundaries, unknown-sha exclusion counting, and a small fixture
   transcript pair.

Not in scope: verdict math changes (06); writing NEW sidecar fields;
multi-repo scoping (scope.ts unchanged).

## Done-when

- [ ] `agent-trends --since-sha <pre-change> ` vs `--before-sha <pre-change>`
      produces the before/after comparison over real local history
      (manual receipt on this machine's sessions).
- [ ] Join + segmentation tests green; unknown shas counted loudly.
- [ ] Canonical gates green; PR merged CLEAN.
