/**
 * Throwaway probe extension for the coordination E2E.
 *
 * Loaded THIRD (after goal-todo and planning-with-files) so that by the time
 * its session_start handler runs, both peers have already published their
 * globalThis seams from their factory bodies (factories run at load time,
 * before session_start is emitted).
 *
 * It dumps a single deterministic JSON line to stderr describing whether the
 * globalThis bridge is live and returns correct data. The test parses this
 * line — it does NOT depend on the model's response.
 */
export default function (pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void }): void {
  pi.on("session_start", () => {
    const g = globalThis as Record<string, unknown>;
    const goalFn = g.__piGoalActive;
    const planFn = g.__piPlanIncomplete;
    const out = {
      marker: "COORD-PROBE-9",
      goalType: typeof goalFn,
      planType: typeof planFn,
      // Call them to prove they're the LIVE functions reading real state,
      // not stale copies — the core uncertainty about jiti<->native identity.
      goalResult: typeof goalFn === "function" ? (goalFn as () => boolean)() : null,
      planResult: typeof planFn === "function" ? (planFn as (cwd: string) => boolean)(process.cwd()) : null,
      cwd: process.cwd(),
    };
    process.stderr.write(`COORD-PROBE-RESULT ${JSON.stringify(out)}\n`);
  });
}
