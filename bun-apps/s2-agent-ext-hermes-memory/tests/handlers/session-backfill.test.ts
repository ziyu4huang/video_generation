import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteBackend } from '../../src/store/sqlite/sqlite-backend.js';
import { SqliteSessionRepository } from '../../src/store/sqlite/sqlite-session-repo.js';
import {
  scheduleSessionBackfill,
  waitForSessionBackfill,
  type SessionBackfillState,
} from '../../src/handlers/session-backfill.js';

function writeJsonlSession(sessionsDir: string, projectDir: string, sessionId: string, text = 'Hello from backfill'): void {
  const projDir = path.join(sessionsDir, projectDir);
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/work/${projectDir}` }),
    JSON.stringify({
      type: 'message',
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: '2026-05-03T00:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    }),
  ];
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n'));
}

describe('session backfill handler', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let backend: SqliteBackend;
  let repo: SqliteSessionRepository;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-backfill-test-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    backend = new SqliteBackend(path.join(tmpDir, 'memory'));
    await backend.init();
    repo = new SqliteSessionRepository(backend);
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('schedules backfill without indexing synchronously, then indexes unindexed sessions', async () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    const callbacks: (() => void)[] = [];
    const state: SessionBackfillState = { inProgress: false, promise: null };

    const scheduled = scheduleSessionBackfill(repo, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    assert.equal(callbacks.length, 1);
    assert.equal(backend.getStats().sessions, 0, 'session_start should not index synchronously');

    const promise = state.promise;
    assert.ok(promise);
    callbacks[0]();
    await promise;

    assert.equal(backend.getStats().sessions, 1);
    assert.equal(backend.getStats().messages, 1);
  });

  it('scheduled task is a no-op when counts match and timestamp is recent', async () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    await repo.indexAllSessions(sessionsDir);
    await repo.touchBackfillTimestamp();

    const callbacks: (() => void)[] = [];
    const state: SessionBackfillState = { inProgress: false, promise: null };
    const scheduled = scheduleSessionBackfill(repo, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        callbacks.push(callback);
        return 0;
      },
    });

    // Always scheduled (async needsBackfill check happens inside the deferred task).
    assert.equal(scheduled, true);
    assert.equal(callbacks.length, 1);

    const promise = state.promise;
    callbacks[0]();
    await promise;

    // No new sessions indexed — the deferred task saw counts match and skipped.
    assert.equal(state.inProgress, false);
    assert.equal(backend.getStats().sessions, 1);
  });

  it('keeps manual indexAllSessions idempotent with auto-backfill', async () => {
    writeJsonlSession(sessionsDir, 'project-a', 's1');
    const state: SessionBackfillState = { inProgress: false, promise: null };

    const scheduled = scheduleSessionBackfill(repo, sessionsDir, {
      state,
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });
    assert.equal(scheduled, true);
    await state.promise;

    const manualResult = await repo.indexAllSessions(sessionsDir);
    assert.equal(manualResult.sessionsProcessed, 1);
    assert.equal(manualResult.sessionsSkipped, 1);
    assert.equal(manualResult.sessionsIndexed, 0);
  });

  it('does not mark backfill complete when startup parse limit is reached', async () => {
    const state: SessionBackfillState = { inProgress: false, promise: null };
    const notifications: { message: string; level: string }[] = [];

    writeJsonlSession(sessionsDir, 'p1', 's1');
    writeJsonlSession(sessionsDir, 'p2', 's2');
    writeJsonlSession(sessionsDir, 'p3', 's3');

    const scheduled = scheduleSessionBackfill(repo, sessionsDir, {
      state,
      maxFilesToIndex: 1,
      notify: (message, level) => notifications.push({ message, level }),
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    // The limit was reached → timestamp NOT touched. Check notification mentions startup limit.
    const limitNotif = notifications.find((n) => /startup limit reached/.test(n.message));
    assert.ok(limitNotif, 'expected a startup-limit-reached notification');
    assert.equal(limitNotif!.level, 'warning');
  });

  it('scheduled task is best-effort and does not reject when indexing throws', async () => {
    const state: SessionBackfillState = { inProgress: false, promise: null };
    const notifications: { message: string; level: string }[] = [];

    // Use a repo whose needsBackfill throws by pointing at a bad dir won't work;
    // instead, use a mock repo that throws during indexChangedSessions.
    const throwingRepo = {
      needsBackfill: async () => true,
      indexChangedSessions: async () => { throw new Error('boom'); },
      touchBackfillTimestamp: async () => {},
    };

    const scheduled = scheduleSessionBackfill(throwingRepo as any, sessionsDir, {
      state,
      notify: (message, level) => notifications.push({ message, level }),
      setTimeoutFn: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
    });

    assert.equal(scheduled, true);
    await state.promise;
    assert.equal(state.inProgress, false);
    assert.match(notifications[0].message, /Session backfill failed: boom/);
    assert.equal(notifications[0].level, 'warning');
  });

  it('shutdown wait resolves true when an in-progress backfill completes before timeout', async () => {
    let resolveBackfill!: () => void;
    const state: SessionBackfillState = {
      inProgress: true,
      promise: new Promise<void>((resolve) => {
        resolveBackfill = resolve;
      }),
    };

    setTimeout(resolveBackfill, 5);
    const completed = await waitForSessionBackfill(100, state);

    assert.equal(completed, true);
  });

  it('shutdown wait resolves false when an in-progress backfill exceeds timeout', async () => {
    const state: SessionBackfillState = {
      inProgress: true,
      promise: new Promise<void>(() => {}),
    };

    const completed = await waitForSessionBackfill(5, state);

    assert.equal(completed, false);
  });
});
