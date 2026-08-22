/**
 * cron-loop.ts + cron-tools.ts (ticket 08): due computation, lease-guarded
 * dispatch with a fake manager, expiry sweep, and the three tool surfaces.
 * No live LLM, no real WorkflowManager.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCronTick, startCronSchedulerLoop } from "../src/cron-loop.js";
import { createCronStore } from "../src/cron-store.js";
import { createCronTools } from "../src/cron-tools.js";

interface FakeDispatchCall {
  script: string;
  args?: unknown;
}

function withEnv(
  fn: (env: {
    root: string;
    store: ReturnType<typeof createCronStore>;
    calls: FakeDispatchCall[];
  }) => void | Promise<void>,
) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dw-cronloop-"));
    const calls: FakeDispatchCall[] = [];
    try {
      await fn({ root, store: createCronStore(root), calls });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** The fake manager — records dispatches; satisfies the CronDispatch seam. */
function fakeDispatch(calls: FakeDispatchCall[]) {
  let n = 0;
  return {
    startInBackground(script: string, args?: unknown) {
      calls.push({ script, args });
      const runId = `run-${++n}`;
      return { runId, promise: Promise.resolve({ ok: true }) };
    },
  };
}

const SCRIPT = "export const meta = { name: 'audit' };";

test(
  "tick fires a due definition once, then not again until the next slot",
  withEnv(({ root, store, calls }) => {
    // Created 09:00 (frozen clock), every 15 min → due at 09:15; tick at 09:15:30.
    const clockStore = createCronStore(root, { now: () => new Date(2026, 7, 23, 9, 0, 0) });
    const def = clockStore.create({ cron: "*/15 * * * *", workflow: "audit", kind: "recurring" });
    assert.ok(def);

    const dispatch = fakeDispatch(calls);
    const tick1 = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 30));
    assert.equal(tick1.fired.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].script, SCRIPT);

    // Immediately again: the anchor moved to the fire time → same slot never refires.
    const tick2 = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 45));
    assert.equal(tick2.fired.length, 0, "no double fire within the same due minute");
    assert.equal(calls.length, 1);

    // Next slot fires once.
    const tick3 = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 30, 5));
    assert.equal(tick3.fired.length, 1);
    assert.equal(calls.length, 2);
  }),
);

test(
  "tick skips a slot whose fire-record lease is held by another live session",
  withEnv(({ root, store, calls }) => {
    // Seed with a frozen clock so the 09:15 slot is due at the tick time below.
    const other = createCronStore(root, { now: () => new Date(2026, 7, 23, 9, 0, 0) }); // the other live session
    const def = other.create({ cron: "*/15 * * * *", workflow: "audit", kind: "recurring" });
    // The other session already claimed the 09:15 slot.
    assert.ok(other.claimFire(def.id, new Date(2026, 7, 23, 9, 15).getTime()));

    // THIS session's store sees the same definition (same root) but loses the claim.
    const dispatch = fakeDispatch(calls);
    const result = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 30));
    assert.deepEqual(result.lostClaims, [def.id]);
    assert.equal(calls.length, 0, "the loser must not dispatch — the double-fire guard");
  }),
);

test(
  "tick records an unresolvable workflow as failed and does not retry every pass",
  withEnv(({ root, store, calls }) => {
    const seeded = createCronStore(root, { now: () => new Date(2026, 7, 23, 9, 0, 0) });
    const def = seeded.create({ cron: "*/15 * * * *", workflow: "gone", kind: "recurring" });
    const dispatch = fakeDispatch(calls);
    const result = runCronTick(store, dispatch, () => null, new Date(2026, 7, 23, 9, 15, 30));
    assert.deepEqual(result.failed, [def.id]);
    assert.equal(calls.length, 0);
    const again = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 45));
    assert.equal(again.failed.length, 0, "the fire was consumed — no retry loop for a missing workflow");
  }),
);

test(
  "tick sweeps expired recurring definitions before firing",
  withEnv(({ root, calls }) => {
    // Created 7+ days ago: create directly via injected clock, then fire-time is later.
    let clock = new Date(2026, 7, 1, 9, 0, 0);
    const clockStore = createCronStore(root, { now: () => clock });
    const def = clockStore.create({ cron: "*/15 * * * *", workflow: "audit", kind: "recurring" });
    clock = new Date(2026, 7, 23, 9, 0, 0); // 22 days later — past expiry

    const store = createCronStore(root);
    const dispatch = fakeDispatch(calls);
    const result = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 30));
    assert.deepEqual(result.expired, [def.id]);
    assert.equal(calls.length, 0, "an expired definition fires nothing");
    assert.equal(store.get(def.id), null);
  }),
);

test(
  "tick quarantines a definition with an invalid expression instead of crashing",
  withEnv(({ store, calls }) => {
    const def = store.create({ cron: "not cron", workflow: "audit", kind: "recurring" });
    const dispatch = fakeDispatch(calls);
    const result = runCronTick(store, dispatch, () => SCRIPT, new Date(2026, 7, 23, 9, 15, 30));
    assert.equal(result.fired.length, 0);
    assert.equal(result.failed.length, 0);
    assert.ok(store.get(def.id), "quarantined, not deleted");
  }),
);

test(
  "startCronSchedulerLoop: stop() clears the interval (loop lifecycle)",
  withEnv(({ store, calls }) => {
    const dispatch = fakeDispatch(calls);
    const loop = startCronSchedulerLoop({ store, dispatch, resolveScript: () => SCRIPT, tickMs: 20 });
    loop.stop();
    // Nothing due anyway; the assertion is that stop() runs clean and nothing throws.
    assert.equal(calls.length, 0);
  }),
);

test(
  "tools: cron_create validates cron + workflow; cron_list renders; cron_delete removes",
  withEnv(async ({ store }) => {
    const tools = createCronTools({ store, resolveScript: (w) => (w === "audit" ? SCRIPT : null) });
    const [create, list, del] = tools as unknown as Array<{
      name: string;
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }>;
    assert.equal(create.name, "cron_create");
    assert.equal(list.name, "cron_list");
    assert.equal(del.name, "cron_delete");

    // Invalid cron rejected.
    const bad = await create.execute("t1", { cron: "oops", workflow: "audit" });
    assert.match(bad.content[0].text, /Invalid cron expression/);
    // Unknown workflow rejected.
    const unknown = await create.execute("t2", { cron: "*/15 * * * *", workflow: "nope" });
    assert.match(unknown.content[0].text, /could not be resolved/);
    // Never-firing expression rejected.
    const never = await create.execute("t3", { cron: "0 0 30 2 *", workflow: "audit" });
    assert.match(never.content[0].text, /never fires/);

    // Valid create → listed → deleted.
    const ok = await create.execute("t4", {
      cron: "*/15 * * * *",
      workflow: "audit",
      kind: "recurring",
      name: "quarterly",
    });
    const text = ok.content[0].text;
    assert.match(text, /quarterly/);
    assert.match(text, /recurring/);

    const listed = await list.execute("t5", {});
    assert.match(listed.content[0].text, /quarterly/);

    const id = store.list()[0].id;
    const gone = await del.execute("t6", { id });
    assert.match(gone.content[0].text, /Deleted/);
    assert.equal(store.list().length, 0);
    const missing = await del.execute("t7", { id });
    assert.match(missing.content[0].text, /No cron schedule/);
  }),
);
