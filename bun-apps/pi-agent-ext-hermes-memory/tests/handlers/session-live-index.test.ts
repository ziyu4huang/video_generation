import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/sqlite/sqlite-backend.js';
import {
  scheduleLiveSessionIndex,
  waitForLiveSessionIndex,
  type SessionLiveIndexState,
} from '../../src/handlers/session-live-index.js';
import { isTransientDbError, runWithTransientRetry } from '../../src/store/sqlite/sqlite-backend.js';

describe('session live indexing handler', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-live-index-test-'));
    dbManager = new DatabaseManager(path.join(tmpDir, 'memory'));
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSnapshot(entries: unknown[]) {
    return {
      getHeader: () => ({ id: 'live-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/live-project' }),
      getEntries: () => entries,
    };
  }

  it('defers indexing so message_end does not block and then indexes live messages', async () => {
    const entries = [{
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: 'hello after message_end' },
    }];
    const callbacks: (() => void)[] = [];
    const state: SessionLiveIndexState = { inProgress: false, promise: null };

    const scheduled = scheduleLiveSessionIndex(dbManager, createSnapshot(entries), {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    assert.equal(callbacks.length, 1);
    assert.equal(dbManager.getStats().messages, 0, 'message_end handler should not index synchronously');

    const promise = state.promise;
    assert.ok(promise);
    callbacks[0]();
    await promise;

    assert.equal(dbManager.getStats().sessions, 1);
    assert.equal(dbManager.getStats().messages, 1);
  });

  it('coalesces multiple scheduled message_end events and indexes all missing entries', async () => {
    const entries = [{
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: 'first' },
    }];
    const callbacks: (() => void)[] = [];
    const state: SessionLiveIndexState = { inProgress: false, promise: null };
    const snapshot = createSnapshot(entries);

    assert.equal(scheduleLiveSessionIndex(dbManager, snapshot, {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    }), true);

    entries.push({
      type: 'message',
      id: 'entry-2',
      timestamp: '2026-05-03T00:02:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    });
    assert.equal(scheduleLiveSessionIndex(dbManager, snapshot, { state, delayMs: 0 }), false);

    const promise = state.promise;
    callbacks[0]();
    await promise;

    assert.equal(dbManager.getStats().sessions, 1);
    assert.equal(dbManager.getStats().messages, 2);
  });

  it('indexes appended messages for an already indexed resumed session', async () => {
    const entries = [{
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: 'before resume' },
    }];
    const snapshot = createSnapshot(entries);
    const state: SessionLiveIndexState = { inProgress: false, promise: null };

    scheduleLiveSessionIndex(dbManager, snapshot, {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    await state.promise;
    assert.equal(dbManager.getStats().messages, 1);

    entries.push({
      type: 'message',
      id: 'entry-2',
      timestamp: '2026-05-03T00:02:00Z',
      message: { role: 'user', content: 'after resume' },
    });
    scheduleLiveSessionIndex(dbManager, snapshot, {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    await state.promise;

    assert.equal(dbManager.getStats().sessions, 1);
    assert.equal(dbManager.getStats().messages, 2);
  });

  it('scheduled live indexing is best-effort and does not reject on errors', async () => {
    const state: SessionLiveIndexState = { inProgress: false, promise: null };
    const errors: unknown[] = [];

    const scheduled = scheduleLiveSessionIndex(dbManager, createSnapshot([]), {
      state,
      indexLiveSessionFn: () => {
        throw new Error('boom');
      },
      onError: (err) => errors.push(err),
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    assert.equal(state.inProgress, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0] instanceof Error ? errors[0].message : String(errors[0]), /boom/);
  });

  it('repairs corruption and retries live indexing once before reporting an error', async () => {
    dbManager.getDb();
    const state: SessionLiveIndexState = { inProgress: false, promise: null };
    const errors: unknown[] = [];
    let attempts = 0;

    const scheduled = scheduleLiveSessionIndex(dbManager, createSnapshot([]), {
      state,
      indexLiveSessionFn: () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('SQLITE_CORRUPT: database disk image is malformed') as Error & { code: string };
          err.code = 'SQLITE_CORRUPT';
          throw err;
        }
        return null;
      },
      onError: (err) => errors.push(err),
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;

    assert.equal(attempts, 2);
    assert.equal(errors.length, 0);
    assert.equal(dbManager.getLastRecovery()?.strategy, 'rebuilt');
  });

  it('shutdown wait resolves true when live indexing completes before timeout', async () => {
    let resolveIndex!: () => void;
    const state: SessionLiveIndexState = {
      inProgress: true,
      promise: new Promise<void>((resolve) => {
        resolveIndex = resolve;
      }),
    };

    setTimeout(resolveIndex, 5);
    const completed = await waitForLiveSessionIndex(100, state);

    assert.equal(completed, true);
  });

  it('shutdown wait resolves false when live indexing exceeds timeout', async () => {
    const state: SessionLiveIndexState = {
      inProgress: true,
      promise: new Promise<void>(() => {}),
    };

    const completed = await waitForLiveSessionIndex(5, state);

    assert.equal(completed, false);
  });

  describe('transient-error retry (absorbs multi-process WAL I/O blips)', () => {
    const transientErr = () => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });

    it('isTransientDbError classifies SQLITE_BUSY / IOERR / "disk I/O error"', () => {
      assert.equal(isTransientDbError(transientErr()), true);
      assert.equal(isTransientDbError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), true);
      assert.equal(isTransientDbError(new Error('no such table: messages')), false);
      assert.equal(isTransientDbError(null), false);
    });

    it('runWithTransientRetry retries a transient error then succeeds', async () => {
      let calls = 0;
      const result = await runWithTransientRetry(() => {
        calls++;
        if (calls < 3) throw transientErr();
        return 'ok';
      }, { maxAttempts: 3, sleep: async () => {} });
      assert.equal(result, 'ok');
      assert.equal(calls, 3);
    });

    it('runWithTransientRetry does NOT retry non-transient errors', async () => {
      let calls = 0;
      await assert.rejects(
        () => runWithTransientRetry(() => { calls++; throw new Error('no such table: messages'); }, { maxAttempts: 3, sleep: async () => {} }),
        /no such table/,
      );
      assert.equal(calls, 1);
    });

    it('runWithTransientRetry gives up after maxAttempts of persistent transient errors', async () => {
      let calls = 0;
      await assert.rejects(
        () => runWithTransientRetry(() => { calls++; throw transientErr(); }, { maxAttempts: 3, sleep: async () => {} }),
        /disk I\/O error/,
      );
      assert.equal(calls, 3);
    });

    it('scheduleLiveSessionIndex absorbs a transient I/O blip without calling onError', async () => {
      let indexCalls = 0;
      const fakeIndex = (): void => {
        indexCalls++;
        if (indexCalls < 3) throw transientErr();
      };
      const errors: unknown[] = [];
      const state: SessionLiveIndexState = { inProgress: false, promise: null };
      scheduleLiveSessionIndex(dbManager, createSnapshot([]), {
        state,
        delayMs: 0,
        indexLiveSessionFn: fakeIndex,
        sleepFn: async () => {},
        onError: (e) => errors.push(e),
        setTimeoutFn: (cb) => { queueMicrotask(cb); return 0; },
      });
      await state.promise;
      assert.equal(indexCalls, 3, 'retried the transient blip to success');
      assert.equal(errors.length, 0, 'transient blip absorbed — onError not called');
    });

    it('scheduleLiveSessionIndex still reports a persistent (non-transient) failure', async () => {
      let indexCalls = 0;
      const fakeIndex = (): void => { indexCalls++; throw new Error('no such table: messages'); };
      const errors: unknown[] = [];
      const state: SessionLiveIndexState = { inProgress: false, promise: null };
      scheduleLiveSessionIndex(dbManager, createSnapshot([]), {
        state,
        delayMs: 0,
        indexLiveSessionFn: fakeIndex,
        sleepFn: async () => {},
        onError: (e) => errors.push(e),
        setTimeoutFn: (cb) => { queueMicrotask(cb); return 0; },
      });
      await state.promise;
      assert.equal(indexCalls, 1, 'non-transient not retried');
      assert.equal(errors.length, 1, 'persistent failure reported');
    });
  });
});
