# t03 — e2e-core-tool-roundtrip: retry-once on kill-cap, counted

## Verified findings

- `bun-apps/s2-agent-ext-devops/tests/e2e-core-tool-roundtrip.test.ts`:
  - `PRIMARY_CAP_MS = 90_000` (line 81, comment: flash-class models fit well
    under 60s; 90s = slow-network headroom);
  - launcher spawn kills at the cap (`proc.kill(9)`, line 128);
  - an artifact-retry precedent exists at :181–185 — "exit-0 run that wrote
    nothing" retries once with a loud `[e2e-write] … retrying once` line;
  - live red 2026-09-07 during arc-10 close-out: latency spike hit the cap →
    exit 137 → false regression signal, passed on immediate re-run.

## Implementation

1. In the primary-run wrapper, detect death-by-cap: killed at the cap means
   either exit code 137/null-with-`SIGKILL` signal or elapsed ≥
   PRIMARY_CAP_MS with nonzero/absent exit — key the retry on the KILL
   SIGNAL + cap-elapse conjunction (D3), not bare 137 (a real crash can also
   die fast; a fast nonzero exit must NOT retry).
2. Retry once, mirroring the artifact-retry shape:
   `console.error('[e2e-write] primary killed at 90s cap (latency) — retrying once (attempt 2/2)')`.
3. A second cap-kill still FAILs (counted output makes it read as persistent
   failure, not flake): `[e2e-write] primary killed at cap twice — FAIL`.

## Tests + receipt design

- This IS the test change. Validate by: `bun test e2e-core-tool-roundtrip`
  green locally; simulate the cap path once by temporarily setting
  PRIMARY_CAP_MS low (e.g. 3s) in a scratch run to watch the retry line fire,
  then restore 90_000 — do not commit the low cap.
- No schema/description strings touched → schema-cost +0.

## Risks / descope

- If Bun's exited() shape lacks signal info, fall back to elapsed ≥ cap ∧
  exit != 0 (the conjunction still excludes fast genuine crashes).
