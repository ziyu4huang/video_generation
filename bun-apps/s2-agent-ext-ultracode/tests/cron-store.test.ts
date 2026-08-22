/**
 * cron-store.ts — durable definitions + lease-claimed fire-records (ticket 08).
 *
 * Two live claimants are simulated with TWO store instances over the same
 * state root: the exclusive `wx` create means exactly one claimFire wins the
 * (id, due) slot — the cross-session double-fire guard.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRON_RECURRING_EXPIRY_MS, createCronStore } from "../src/cron-store.js";

function withStateRoot(fn: (root: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dw-cron-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "definitions round-trip durably across store instances",
  withStateRoot((root) => {
    const clock = new Date(2026, 7, 23, 9, 0, 0);
    const store = createCronStore(root, { now: () => clock });
    const def = store.create({ cron: "*/15 * * * *", workflow: "audit", kind: "recurring", name: "quarterly audit" });
    assert.equal(def.firedCount, 0);
    assert.equal(def.kind, "recurring");
    // Recurring: expires 7 days after creation.
    assert.equal(Date.parse(def.expiresAt ?? ""), clock.getTime() + CRON_RECURRING_EXPIRY_MS);

    // A fresh store instance (next session) sees the same definition — durability.
    const reopened = createCronStore(root);
    assert.equal(reopened.list().length, 1);
    // JSON round-trip drops `args: undefined` — compare the persisted shape.
    assert.deepEqual(reopened.get(def.id), JSON.parse(JSON.stringify(def)));
    assert.equal(reopened.get("cron-nope"), null);
  }),
);

test(
  "one-shot: markFired deletes the definition; recurring: stamps + keeps",
  withStateRoot((root) => {
    const store = createCronStore(root);
    const oneShot = store.create({ cron: "0 9 1 1 *", workflow: "flash", kind: "one-shot" });
    store.markFired(oneShot.id, new Date(2027, 0, 1, 9, 0).toISOString());
    assert.equal(store.get(oneShot.id), null, "one-shot deletes itself after its single fire");

    const rec = store.create({ cron: "*/15 * * * *", workflow: "audit", kind: "recurring" });
    store.markFired(rec.id, new Date(2026, 7, 23, 9, 15).toISOString());
    const stamped = store.get(rec.id);
    assert.equal(stamped?.firedCount, 1);
    assert.equal(stamped?.lastFiredAt, new Date(2026, 7, 23, 9, 15).toISOString());
    // markFired on an id deleted meanwhile is a no-op, not a crash.
    store.markFired("cron-gone", new Date().toISOString());
  }),
);

test(
  "fire-record lease: exactly one of two concurrent claimants wins",
  withStateRoot((root) => {
    const storeA = createCronStore(root);
    const storeB = createCronStore(root); // second live session, same state root
    const def = storeA.create({ cron: "* * * * *", workflow: "audit", kind: "recurring" });
    const dueMs = new Date(2026, 7, 23, 9, 15).getTime();

    const first = storeA.claimFire(def.id, dueMs);
    assert.ok(first, "first claimant wins");
    assert.equal(first.definitionId, def.id);
    assert.equal(first.dueMs, dueMs);

    const second = storeB.claimFire(def.id, dueMs);
    assert.equal(second, null, "second live claimant is blocked — no double fire");

    // A different due slot is a different lease — claimable.
    const nextSlot = storeB.claimFire(def.id, dueMs + 60_000);
    assert.ok(nextSlot, "a different due minute claims independently");
  }),
);

test(
  "fire-record lease: stale (dead-owner) record is swept and re-claimable",
  withStateRoot((root) => {
    const store = createCronStore(root);
    const def = store.create({ cron: "* * * * *", workflow: "audit", kind: "recurring" });
    const dueMs = new Date(2026, 7, 23, 9, 15).getTime();

    // A record left behind by a crashed process: pid far beyond the OS pid range
    // is definitively dead (kill → ESRCH), like an owner that exited after claiming.
    const firesDir = join(root, "cron", "fires");
    if (!existsSync(firesDir)) mkdirSync(firesDir, { recursive: true });
    const stalePid = 999_999_99;
    const recordPath = join(firesDir, `${def.id}-${dueMs}.json`);
    writeFileSync(
      recordPath,
      JSON.stringify({ definitionId: def.id, dueMs, pid: stalePid, claimedAt: "2026-08-23T09:15:00.000Z" }),
    );

    const reclaimed = store.claimFire(def.id, dueMs);
    assert.ok(reclaimed, "a dead owner's record is swept and the slot re-claimed");

    // completeFire stamps the outcome onto the record (runId or error).
    store.completeFire(reclaimed, { runId: "run-123" });
    const stamped = JSON.parse(readFileSync(join(firesDir, `${def.id}-${dueMs}.json`), "utf8"));
    assert.equal(stamped.runId, "run-123");
  }),
);

test(
  "sweepExpired drops past-expiry recurring definitions only",
  withStateRoot((root) => {
    let clock = new Date(2026, 7, 16, 9, 0, 0);
    const store = createCronStore(root, { now: () => clock });
    const expiring = store.create({ cron: "* * * * *", workflow: "old", kind: "recurring" });
    const oneShot = store.create({ cron: "0 9 1 1 *", workflow: "flash", kind: "one-shot" });

    // A week later: `expiring` is past expiry (createdAt + 7d <= now), one-shot has none.
    clock = new Date(2026, 7, 23, 9, 0, 1);
    const swept = store.sweepExpired(clock);
    assert.deepEqual(swept, [expiring.id]);
    assert.equal(store.get(expiring.id), null);
    assert.ok(store.get(oneShot.id), "one-shot has no expiresAt and is never swept");
  }),
);

test(
  "delete removes only the named definition",
  withStateRoot((root) => {
    const store = createCronStore(root);
    const a = store.create({ cron: "* * * * *", workflow: "a", kind: "recurring" });
    store.create({ cron: "* * * * *", workflow: "b", kind: "recurring" });
    assert.equal(store.delete(a.id), true);
    assert.equal(store.delete(a.id), false);
    assert.equal(store.list().length, 1);
  }),
);

test(
  "gcFireRecords drops records past the 7-day horizon, keeps fresh ones",
  withStateRoot((root) => {
    const oldClock = new Date(2026, 7, 1, 9, 0, 0);
    const old = createCronStore(root, { now: () => oldClock });
    const defA = old.create({ cron: "* * * * *", workflow: "a", kind: "recurring" });
    assert.ok(old.claimFire(defA.id, oldClock.getTime())); // claimed 3 weeks before "now"

    const fresh = createCronStore(root);
    const defB = fresh.create({ cron: "* * * * *", workflow: "b", kind: "recurring" });
    assert.ok(fresh.claimFire(defB.id, Date.now()));

    const now = new Date(2026, 7, 23, 9, 0, 0);
    const removed = fresh.gcFireRecords(now);
    assert.equal(removed, 1, "only the past-horizon record is removed");
    const remaining = readdirSync(join(root, "cron", "fires")).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 1);
    assert.match(remaining[0] ?? "", new RegExp(`^${defB.id}-`));
  }),
);
