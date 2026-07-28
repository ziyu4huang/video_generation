import type { SessionRepository } from '../store/repository.js';
import type { TimedFn } from '../perf.js';
import type { SessionManagerSnapshot } from '../store/session-parser.js';
import { parseSessionManagerSnapshot } from '../store/session-parser.js';

export const SESSION_LIVE_INDEX_DELAY_MS = 50;
export const SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS = 5000;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface SessionLiveIndexState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const sessionLiveIndexState: SessionLiveIndexState = {
  inProgress: false,
  promise: null,
};

export interface ScheduleLiveSessionIndexOptions {
  state?: SessionLiveIndexState;
  setTimeoutFn?: SetTimeoutFn;
  delayMs?: number;
  onError?: (error: unknown) => void;
  /** Perf wrapper (default pass-through). index.ts injects the real recorder. */
  timed?: TimedFn;
}

/**
 * Schedule non-blocking indexing of the current live session.
 *
 * Pi emits message_end before it appends the finalized message to the JSONL
 * session file/session manager. Deferring briefly lets Pi persist the entry
 * first, then we index any message ids not already present in SQLite. Multiple
 * message_end events in the same window coalesce into one all-missing sync.
 *
 * Recovery + transient retry are owned by the repository; this scheduler does
 * NOT double-wrap them.
 */
export function scheduleLiveSessionIndex(
  sessionRepo: SessionRepository,
  sessionManager: SessionManagerSnapshot,
  options: ScheduleLiveSessionIndexOptions = {},
): boolean {
  const state = options.state ?? sessionLiveIndexState;
  if (state.inProgress) {
    return false;
  }

  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const delayMs = options.delayMs ?? SESSION_LIVE_INDEX_DELAY_MS;
  const timed: TimedFn = options.timed ?? ((_op, fn) => fn());

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        await timed("live-index.indexSession", async () => {
          const session = parseSessionManagerSnapshot(sessionManager);
          if (session) {
            await sessionRepo.indexSession(session);
          }
        });
      } catch (err) {
        try { options.onError?.(err); } catch { /* best effort */ }
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, delayMs);
  });

  return true;
}

export async function waitForLiveSessionIndex(
  timeoutMs = SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS,
  state: SessionLiveIndexState = sessionLiveIndexState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) {
    return true;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
