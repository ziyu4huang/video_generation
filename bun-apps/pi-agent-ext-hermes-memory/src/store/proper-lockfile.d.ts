// Ambient declaration for proper-lockfile@4 (CJS, ships no bundled types).
// v4's lock() resolves to a RELEASE FUNCTION: `const release = await lock(...); …; await release();`
// (not an object with .release()). unlock() remains as a legacy fallback.
declare module "proper-lockfile" {
  interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }
  interface LockOptions {
    /** ms after which a held lock is considered stale (0 = never; default 0 — set explicitly!). */
    stale?: number;
    /** ms interval to refresh the lockfile mtime, proving the holder is alive. */
    update?: number;
    /** Acquisition retry policy. Set to BLOCK until the lock is acquirable (default: no retries → ELOCKED). */
    retries?: number | RetryOptions;
    /** Custom lockfile path (default `${file}.lock`). */
    lockfilePath?: string;
    realpath?: boolean;
    fs?: unknown;
    onCompromised?: (err: Error) => void;
  }
  interface UnlockOptions {
    lockfilePath?: string;
    realpath?: boolean;
    fs?: unknown;
  }
  /** v4: the value lock() resolves to — call it to release. */
  export type ReleaseFn = () => Promise<void>;
  export function lock(file: string, options?: LockOptions): Promise<ReleaseFn>;
  export function unlock(file: string, options?: UnlockOptions): Promise<void>;
  export function check(file: string, options?: { stale?: number; lockfilePath?: string; fs?: unknown }): Promise<boolean>;
  export function lockSync(file: string, options?: LockOptions): ReleaseFn;
  export function unlockSync(file: string, options?: UnlockOptions): void;
  export function checkSync(file: string, options?: { stale?: number; lockfilePath?: string; fs?: unknown }): boolean;
  const _default: { lock: typeof lock; unlock: typeof unlock; check: typeof check };
  export default _default;
}
