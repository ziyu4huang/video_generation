import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteBackend } from '../../src/store/sqlite/sqlite-backend.js';
import { SqliteSessionRepository } from '../../src/store/sqlite/sqlite-session-repo.js';
import {
  scheduleLiveSessionIndex,
  waitForLiveSessionIndex,
  type SessionLiveIndexState,
} from '../../src/handlers/session-live-index.js';
import { parseSessionManagerSnapshot } from '../../src/store/session-parser.js';

describe('session live indexing handler', () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let repo: SqliteSessionRepository;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-live-index-test-'));
    backend = new SqliteBackend(path.join(tmpDir, 'memory'));
    await backend.init();
    repo = new SqliteSessionRepository(backend);
  });

  afterEach(() => {
    backend.close();
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

    const scheduled = scheduleLiveSessionIndex(repo, createSnapshot(entries), {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    assert.equal(callbacks.length, 1);
    assert.equal(backend.getStats().messages, 0, 'message_end handler should not index synchronously');

    const promise = state.promise;
    assert.ok(promise);
    callbacks[0]();
    await promise;

    assert.equal(backend.getStats().sessions, 1);
    assert.equal(backend.getStats().messages, 1);
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

    assert.equal(scheduleLiveSessionIndex(repo, snapshot, {
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
    assert.equal(scheduleLiveSessionIndex(repo, snapshot, { state, delayMs: 0 }), false);

    const promise = state.promise;
    callbacks[0]();
    await promise;

    assert.equal(backend.getStats().sessions, 1);
    assert.equal(backend.getStats().messages, 2);
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

    scheduleLiveSessionIndex(repo, snapshot, {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    await state.promise;
    assert.equal(backend.getStats().messages, 1);

    entries.push({
      type: 'message',
      id: 'entry-2',
      timestamp: '2026-05-03T00:02:00Z',
      message: { role: 'user', content: 'after resume' },
    });
    scheduleLiveSessionIndex(repo, snapshot, {
      state,
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    await state.promise;

    assert.equal(backend.getStats().sessions, 1);
    assert.equal(backend.getStats().messages, 2);
  });

  it('scheduled live indexing is best-effort and does not reject on errors', async () => {
    const state: SessionLiveIndexState = { inProgress: false, promise: null };
    const errors: unknown[] = [];

    // Mock repo that throws on indexSession.
    const throwingRepo = {
      indexSession: async () => { throw new Error('boom'); },
    };

    const scheduled = scheduleLiveSessionIndex(throwingRepo as any, createSnapshot([{
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: 'hello' },
    }]), {
      state,
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

  it('snapshot with no usable header resolves as a no-op without error', async () => {
    const state: SessionLiveIndexState = { inProgress: false, promise: null };
    const errors: unknown[] = [];

    const emptySnapshot = {
      getHeader: () => null,
      getEntries: () => [],
    };

    const scheduled = scheduleLiveSessionIndex(repo, emptySnapshot, {
      state,
      onError: (err) => errors.push(err),
      delayMs: 0,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    assert.equal(errors.length, 0);
    assert.equal(backend.getStats().sessions, 0);
  });

  it('parseSessionManagerSnapshot round-trips through repo.indexSession', async () => {
    const snapshot = createSnapshot([{
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: 'round-trip test' },
    }]);
    const parsed = parseSessionManagerSnapshot(snapshot);
    assert.ok(parsed);
    const result = await repo.indexSession(parsed!);
    assert.equal(result.messagesIndexed, 1);
    assert.equal(backend.getStats().sessions, 1);
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
});
