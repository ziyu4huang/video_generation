import { WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";

export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

/**
 * Run a promise with a timeout.
 */
/**
 * Run an agent call under an optional timeout. Unlike a plain Promise.race,
 * a timeout ABORTS the agent's own child signal (derived from `parentSignal`),
 * so a real WorkflowAgent session is cancelled via session.abort() and reports
 * its partial usage in its finally — instead of being orphaned mid-flight with
 * its tokens never counted (RCA#10). After the abort the real promise is still
 * awaited (swallowing the expected abort rejection) so that usage capture runs
 * before the timeout error propagates.
 *
 * `runFn` receives the child signal to pass to the agent. When `timeoutMs` is
 * null (the default) the parent signal is passed through unchanged.
 */
export async function runAgentWithTimeout<T>(
  runFn: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | null,
  parentSignal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  // Default path: no timeout — pass the parent signal through unchanged.
  if (timeoutMs === null) return runFn(parentSignal);

  // Derive a child signal that fires on timeout OR parent abort, so a timeout
  // cancels just this agent (not the whole run) while a parent abort still
  // propagates into the session.
  const controller = new AbortController();
  const abortChildFromParent = () => controller.abort((parentSignal as AbortSignal & { reason?: unknown })?.reason);
  if (parentSignal?.aborted) {
    controller.abort((parentSignal as AbortSignal & { reason?: unknown })?.reason);
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", abortChildFromParent, { once: true });
  }

  const realPromise = runFn(controller.signal);
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      // Cancel the in-flight session; it settles and reports usage in its finally.
      controller.abort();
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${timeoutMs}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([realPromise, timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      // The session has been told to abort. Wait for it to settle so its finally
      // runs (reporting partial usage via onUsage, counted by the caller, and
      // disposing the session) — closing the orphan-token hole. The abort
      // rejection is expected; swallow it. Real agents honor abort and settle
      // promptly; agents that ignore their signal settle on their own.
      await realPromise.catch(() => {});
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (parentSignal) parentSignal.removeEventListener("abort", abortChildFromParent);
  }
}
