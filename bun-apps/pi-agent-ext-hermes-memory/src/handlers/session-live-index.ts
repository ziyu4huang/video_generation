import type { DatabaseManager } from '../store/db.js';
import { indexLiveSession } from '../store/session-indexer.js';

export const SESSION_LIVE_INDEX_DELAY_MS = 50;
export const SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS = 5000;
export const SESSION_LIVE_INDEX_TRANSIENT_MAX_ATTEMPTS = 3;
export const SESSION_LIVE_INDEX_TRANSIENT_BACKOFF_MS = 50;

/**
 * True for transient SQLite write failures (lock contention / momentary I-O
 * blips) common when multiple processes share the WAL database. These are NOT
 * corruption (DatabaseManager.isCorruptionError + withCorruptionRecovery handle
 * that path) and usually clear on a retry, so the live indexer retries them
 * instead of surfacing a noisy `disk I/O error` warning on every blip.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err) return false;
  const code = typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_IOERR') return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('disk i/o error')
    || message.includes('database is locked')
    || message.includes('sqlite_busy')
    || message.includes('sqlite_locked')
    || message.includes('sqlite_ioerr');
}

/**
 * Run an operation with a bounded retry on transient (non-corruption) errors.
 * Corruption-class errors are NOT retried here — the caller wraps the operation
 * in withCorruptionRecovery, which rebuilds the DB; this layer only absorbs
 * contention/I-O blips a rebuild cannot fix. `sleep` is injectable for tests.
 */
export async function runWithTransientRetry<T>(
  operation: () => T,
  opts: { maxAttempts?: number; isRetryable?: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? SESSION_LIVE_INDEX_TRANSIENT_MAX_ATTEMPTS;
  const isRetryable = opts.isRetryable ?? isTransientDbError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryable(err)) {
        await sleep(SESSION_LIVE_INDEX_TRANSIENT_BACKOFF_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable — loop always returns or throws
}

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

type SessionManagerSnapshot = Parameters<typeof indexLiveSession>[1];

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
  indexLiveSessionFn?: typeof indexLiveSession;
  delayMs?: number;
  onError?: (error: unknown) => void;
  /** Max attempts for transient-error retry (default 3). */
  maxAttempts?: number;
  /** Injectable backoff sleep for the transient retry (default: setTimeout). */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Schedule non-blocking indexing of the current live session.
 *
 * Pi emits message_end before it appends the finalized message to the JSONL
 * session file/session manager. Deferring briefly lets Pi persist the entry
 * first, then we index any message ids not already present in SQLite. Multiple
 * message_end events in the same window coalesce into one all-missing sync.
 */
export function scheduleLiveSessionIndex(
  dbManager: DatabaseManager,
  sessionManager: SessionManagerSnapshot,
  options: ScheduleLiveSessionIndexOptions = {},
): boolean {
  const state = options.state ?? sessionLiveIndexState;
  if (state.inProgress) {
    return false;
  }

  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const indexLiveSessionFn = options.indexLiveSessionFn ?? indexLiveSession;
  const delayMs = options.delayMs ?? SESSION_LIVE_INDEX_DELAY_MS;

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        // Corruption errors get the DB-rebuild treatment (withCorruptionRecovery);
        // transient contention/I-O blips are absorbed by runWithTransientRetry so
        // multi-process WAL races don't surface a scary `disk I/O error` warning
        // on every message_end.
        await runWithTransientRetry(
          () => dbManager.withCorruptionRecovery(() => indexLiveSessionFn(dbManager, sessionManager)),
          { maxAttempts: options.maxAttempts, sleep: options.sleepFn },
        );
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
