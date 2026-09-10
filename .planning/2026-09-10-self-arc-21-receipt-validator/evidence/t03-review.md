All gates run. Writing the verdict.

## Review — PR #2257 `self-arc-21-receipt-validator` (independent receipt validator)

### Claim 1: INDEPENDENCE (D4) — VERIFIED

Every use of the self-grade traced in `bun-apps/s2-agent-ext-devops/src/validate-qualify-receipts.ts`:

- Line 177: `const selfPass = typeof receipt.pass === "boolean" ? receipt.pass : undefined;` — the sole read of `receipt.pass`.
- Line ~227 (return): `derivedPass: problems.length === 0, problems, selfPass, agree: …` — `selfPass` flows only into the report fields.
- `receipt.checks` is never read at all.
- Sweep level (~line 272): `const ok = scenarios.every((s) => s.derivedPass) && problems.length === 0;` — no self-grade input. `allAgree` is report-only (the CLI exit code uses it for disagreement signaling, which is flagging, not grading).
- The test suite covers independence both directions — including "a self-graded RED with green evidence still grades GREEN (evidence wins both ways)" — 10 pass / 0 fail (ran it).

### Claim 2: Red-bar ritual — VERIFIED

- `git log` shows the two commits: `435f5642` (TOOTHLESS) → `c79c77e0` (EVIDENCE-DERIVED).
- `git show 435f5642:…/validate-qualify-receipts.ts` line 226: `derivedPass: selfPass ?? false`, and line 271–272 sweep problems report-only.
- `evidence/t02-red-bar.txt` shows the canary RED in that state: 4 variants of `expect(res.ok).toBe(false)` → `Received: true`.
- HEAD carries the flip (`derivedPass: problems.length === 0`) and the suite is green.

### Claim 3: Real-sweep calibration — VERIFIED

- `grep -c` live markers in `output/qualify19-full/cc-parity/snap-33-finding.txt` → `1` (spinner frame present), grounding `settledLike: null` for the background-run scenarios.
- `bun bun-apps/s2-agent-ext-devops/scripts/validate-qualify-receipts.ts output/qualify19-full` → exit 0, 10× `"derivedPass": true`, `"allAgree": true`, no problems.

### Claim 4: Scenario table fidelity — VERIFIED (spot-checks)

- `dispatch`: `scripts/tui-drive.ts:387,396,459,470,476` emit exactly `boot/submitted/settled/viewer/viewer-detail` — matches table `required` exactly.
- `wf-pause`: unconditional `boot` (951), `pause-navigator` (995), `paused-shared` (1017) = `required`; the ternary at 1048 `snap(completed ? "completed" : "running-again", true)` = the `anyOf` group, exactly.

### Gates I ran

`bun test tests/validate-qualify-receipts.test.ts` → 10/0. `bunx tsc --noEmit` → exit 0. `bun run check` (this package's canonical gate; it has no `typecheck` script) → exit 0.

### Findings

**Blockers:** none.

**Should-fix:** none.

**Nits:**
1. `.planning/2026-09-10-self-arc-21-receipt-validator/evidence/t02-red-bar.txt:3` — header records `head: a4ea2e29` (the ledger-claim commit), so the red run graded an uncommitted worktree rather than pinning `435f5642`. The failure signature matches the toothless semantics exactly and `git show 435f5642` independently proves the state, so this is evidence-labeling only.
2. `src/validate-qualify-receipts.ts:42` — `LIVE_MARKER_RE` is a byte-copy of `s2-agent-ext-subagent/scripts/lib/bench-base-tech/screen.ts:59` (verified identical today). Deliberate per D4 (no import of graded code), but nothing guards against drift: if screen.ts gains spinner frames, the validator would silently pass live screens as settled. A one-line test asserting the two pattern sources stay equal would close it.

VERDICT: APPROVE