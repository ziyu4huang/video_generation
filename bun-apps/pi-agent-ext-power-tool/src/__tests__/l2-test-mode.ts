/**
 * Pure decision logic for how l2-e2e.test.ts registers each tool's test:
 *   - "run"  — no blockers, execute the real assertion body.
 *   - "skip" — blocked (L2 disabled, or a required service is down) and not
 *              required to fail — registers as bun:test's test.skip().
 *   - "fail" — blocked AND PI_REQUIRE_L2=1 (and L2 itself is enabled) — used
 *              by run-test.sh's `full` tier so a down service fails the run
 *              instead of silently skipping.
 * Extracted so this branching can be unit-tested without spawning the real
 * CLI or probing LM Studio / vault-mind.
 */
export interface TestModeResult {
  mode: "run" | "skip" | "fail";
  title: string;
}

export function resolveTestMode(
  toolName: string,
  blockers: string[],
  l2Enabled: boolean,
  requireL2: boolean,
): TestModeResult {
  if (blockers.length === 0) {
    return { mode: "run", title: `L2: ${toolName}` };
  }
  if (l2Enabled && requireL2) {
    return { mode: "fail", title: `L2: ${toolName} — REQUIRED but blocked (${blockers.join("; ")})` };
  }
  return { mode: "skip", title: `L2: ${toolName} — skipped (${blockers.join("; ")})` };
}
