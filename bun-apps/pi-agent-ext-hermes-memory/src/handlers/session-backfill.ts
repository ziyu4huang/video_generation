import type { SessionRepository, BulkIndexResult } from '../store/repository.js';

export const SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS = 5000;
export const SESSION_BACKFILL_MAX_FILES = 50;

type NotifyLevel = 'info' | 'warning' | 'error';
type NotifyFn = (message: string, level: NotifyLevel) => void;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface SessionBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const sessionBackfillState: SessionBackfillState = {
  inProgress: false,
  promise: null,
};

export interface ScheduleSessionBackfillOptions {
  notify?: NotifyFn;
  state?: SessionBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  maxFilesToIndex?: number;
}

function formatBackfillResult(result: BulkIndexResult): string {
  const errorSuffix = result.errors.length > 0 ? ` (${result.errors.length} file error${result.errors.length === 1 ? '' : 's'})` : '';
  const limitSuffix = result.reachedLimit ? ' (startup limit reached)' : '';
  return `🧠 Session backfill complete: ${result.sessionsIndexed} indexed, ${result.sessionsSkipped} skipped, ${result.messagesIndexed} messages${errorSuffix}${limitSuffix}.`;
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    // Notification failures must never affect backfill.
  }
}

/**
 * Schedule a best-effort, bounded incremental backfill of unindexed Pi sessions.
 *
 * The JSONL parsing work is deferred with setTimeout(0) so session_start can
 * resolve first. The scheduled pass only parses files without matching stored
 * metadata and caps the number of files parsed per startup.
 *
 * @returns true when a backfill task was scheduled; false when it was skipped.
 */
export function scheduleSessionBackfill(
  sessionRepo: SessionRepository,
  sessionsDir: string,
  options: ScheduleSessionBackfillOptions = {},
): boolean {
  const state = options.state ?? sessionBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const maxFilesToIndex = options.maxFilesToIndex ?? SESSION_BACKFILL_MAX_FILES;

  if (state.inProgress) {
    return false;
  }

  // Pre-check synchronously to avoid scheduling a no-op. The repo method is
  // async, so we drive the scheduled task with its own await chain below; the
  // eager check just gates whether we enter the scheduler at all.
  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        // Re-check inside the deferred task: the eager entry may have raced
        // with another startup, but by the time this fires the DB state is
        // authoritative.
        const shouldRun = await sessionRepo.needsBackfill(sessionsDir);
        if (!shouldRun) {
          return;
        }
        const result = await sessionRepo.indexChangedSessions(sessionsDir, { maxFilesToIndex });
        if (!result.reachedLimit) await sessionRepo.touchBackfillTimestamp();
        notifyBestEffort(options.notify, formatBackfillResult(result), result.errors.length > 0 || result.reachedLimit ? 'warning' : 'info');
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Session backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });

  return true;
}

/**
 * Wait briefly for an in-progress backfill before shutdown closes SQLite.
 *
 * @returns true if no backfill was running or it completed before the timeout;
 * false if the timeout elapsed first.
 */
export async function waitForSessionBackfill(
  timeoutMs = SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS,
  state: SessionBackfillState = sessionBackfillState,
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
