/**
 * Throwaway probe extension for the yield E2E (Plan A).
 *
 * Loaded THIRD (after power-tool and planning-with-files). Hooks
 * `before_agent_start` — the SAME event planning-with-files uses to decide
 * whether to inject the plan. By the time this event fires, power-tool has
 * already restored any seeded goal from the session at `session_start`, so
 * `globalThis.__piGoalActive` reflects the live goal state at the exact moment
 * planning made (or yielded) its injection decision.
 *
 * It dumps a single deterministic JSON line to stderr: whether the goal is
 * active at injection-decision time. The test pairs this with an assertion
 * that the plan's unique token is ABSENT from stdout — together proving
 * planning YIELDED its injection to the active goal (not that injection
 * failed for some other reason).
 */
export default function (pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void }): void {
  pi.on("before_agent_start", () => {
    const g = globalThis as Record<string, unknown>;
    const goalFn = g.__piGoalActive;
    const goalActive = typeof goalFn === "function" ? (goalFn as () => boolean)() : null;
    process.stderr.write(`YIELD-PROBE-RESULT ${JSON.stringify({ goalActive })}\n`);
  });
}
