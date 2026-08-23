/**
 * wakeup-registry.ts (cc-parity-2 ticket 06): scheduling/replacement, due
 * sweep, fixed-mode auto-reschedule, dynamic no-reschedule, the fire cap, the
 * footer, and the tick loop with an injectable tick — mirrors cron-loop.test.ts.
 * No live LLM, no real session.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildWakeupFooter,
  runWakeupTick,
  startWakeupLoop,
  WAKEUP_FIRE_CAP,
  WakeupRegistry,
} from "../src/wakeup-registry.js";

function fixture(nowMs: number) {
  const registry = new WakeupRegistry();
  const fired: Array<{ id: string; prompt: string }> = [];
  const notifications: string[] = [];
  const fire = (id: string, prompt: string) => fired.push({ id, prompt });
  const now = new Date(nowMs);
  return { registry, fired, notifications, fire, now };
}

const T0 = Date.parse("2026-08-23T12:00:00Z");

test("schedule replaces the pending wakeup for the same id (max 1 per loop)", () => {
  const { registry } = fixture(T0);
  registry.schedule({ id: "loop-1", prompt: "p", mode: "dynamic", dueAt: T0 + 60_000 });
  registry.schedule({ id: "loop-1", prompt: "p", mode: "dynamic", dueAt: T0 + 300_000 });
  assert.equal(registry.list().length, 1, "one pending wakeup per id");
  assert.equal(registry.get("loop-1")!.dueAt, T0 + 300_000, "the later schedule won");
});

test("due() removes the entry and snapshots it for the dynamic re-arm", () => {
  const { registry } = fixture(T0);
  registry.schedule({ id: "loop-1", prompt: "watch CI", mode: "dynamic", dueAt: T0 - 1_000 });
  const due = registry.due(new Date(T0));
  assert.equal(due.length, 1);
  assert.equal(registry.get("loop-1"), undefined, "pending is gone after the sweep");
  assert.equal(registry.lastFired("loop-1")!.prompt, "watch CI", "last-fired snapshot keeps the prompt");
});

test("tick fires a fixed loop and auto-reschedules at the constant delay from the FIRE time", () => {
  const { registry, fired, fire, notifications } = fixture(T0);
  registry.schedule({ id: "loop-1", prompt: "check builds", mode: "fixed", delaySeconds: 300, dueAt: T0 - 60_000 });
  // Overdue by 60s — the next anchor is the fire time, not dueAt (missed slots collapse).
  const r1 = runWakeupTick(registry, fire, new Date(T0), undefined);
  assert.equal(r1.fired.length, 1);
  assert.equal(fired.length, 1);
  assert.equal(r1.ended.length, 0);
  assert.match(fired[0]!.prompt, /check builds/);
  assert.match(fired[0]!.prompt, /\[wakeup loop loop-1 — fire 1\//, "the footer cites the loop + fire count");
  assert.match(fired[0]!.prompt, /do NOT call schedule_wakeup/, "fixed footer tells the model not to re-arm");
  assert.equal(registry.get("loop-1")!.dueAt, T0 + 300_000, "rescheduled from the fire time");
  assert.equal(registry.get("loop-1")!.fireCount, 1);

  // Not due again yet; then due once and only once per slot.
  const r2 = runWakeupTick(registry, fire, new Date(T0 + 299_000), undefined);
  assert.equal(r2.fired.length, 0);
  const r3 = runWakeupTick(registry, fire, new Date(T0 + 300_000), undefined);
  assert.equal(r3.fired.length, 1);
  assert.equal(registry.get("loop-1")!.fireCount, 2);
  assert.ok(notifications.length === 0);
});

test("tick fires a dynamic loop WITHOUT rescheduling — the model re-arms from the fired turn", () => {
  const { registry, fired, fire } = fixture(T0);
  registry.schedule({
    id: "loop-1",
    prompt: "watch the deploy",
    mode: "dynamic",
    dueAt: T0 - 1,
    lastReason: "initial /loop dynamic fire",
  });
  const r = runWakeupTick(registry, fire, new Date(T0), undefined);
  assert.equal(r.fired.length, 1);
  assert.match(fired[0]!.prompt, /Last wakeup reason: initial \/loop dynamic fire/);
  assert.equal(registry.get("loop-1"), undefined, "dynamic does not auto-reschedule");
  assert.equal(r.ended.length, 0, "no premature 'ended' — the tool call happens inside the fired turn");
});

test("fire cap: a capped loop ends with a notification instead of firing", () => {
  const { registry, fired, fire, notifications } = fixture(T0);
  registry.schedule({
    id: "loop-1",
    prompt: "p",
    mode: "fixed",
    delaySeconds: 60,
    dueAt: T0 - 1,
    fireCount: WAKEUP_FIRE_CAP,
  });
  const r = runWakeupTick(registry, fire, new Date(T0), (m) => notifications.push(m));
  assert.equal(fired.length, 0, "a capped loop must not fire again");
  assert.deepEqual(r.ended, [{ id: "loop-1", reason: `fire cap reached (${WAKEUP_FIRE_CAP}) — loop auto-stopped` }]);
  assert.equal(registry.get("loop-1"), undefined);
});

test("a throwing fire does not crash the tick (fixed still reschedules)", () => {
  const { registry } = fixture(T0);
  registry.schedule({ id: "loop-1", prompt: "p", mode: "fixed", delaySeconds: 60, dueAt: T0 - 1 });
  const notifications: string[] = [];
  const boom = () => {
    throw new Error("sendUserMessage exploded");
  };
  const r = runWakeupTick(registry, boom, new Date(T0), (m) => notifications.push(m));
  assert.equal(r.fired.length, 1);
  assert.ok(registry.get("loop-1"), "the fixed loop still re-armed after the failed fire");
  assert.ok(
    notifications.some((m) => m.includes("failed")),
    "the failure was reported, not swallowed silently",
  );
});

test("startWakeupLoop: the interval fires a due wakeup; stop() halts it", async () => {
  const registry = new WakeupRegistry();
  const fired: string[] = [];
  registry.schedule({ id: "loop-1", prompt: "tick me", mode: "dynamic", dueAt: Date.now() - 1 });
  const loop = startWakeupLoop({ registry, fire: (_id, prompt) => fired.push(prompt), tickMs: 20 });
  await new Promise((r) => setTimeout(r, 200));
  const atStop = fired.length;
  assert.ok(atStop >= 1, `the interval fired the due wakeup (got ${atStop})`);
  loop.stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired.length, atStop, "no fires after stop()");
});

test("buildWakeupFooter: dynamic instructs re-arm, fixed forbids it", () => {
  const dyn = buildWakeupFooter({ id: "loop-2", prompt: "p", dueAt: 0, mode: "dynamic", fireCount: 0 }, 3);
  assert.match(dyn, /fire 3\//);
  assert.match(dyn, /schedule_wakeup/);
  const fixed = buildWakeupFooter(
    { id: "loop-2", prompt: "p", dueAt: 0, mode: "fixed", delaySeconds: 60, fireCount: 0 },
    3,
  );
  assert.match(fixed, /do NOT call schedule_wakeup/);
  assert.doesNotMatch(fixed, /Last wakeup reason/, "no reason line when none was recorded");
});
