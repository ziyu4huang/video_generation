/**
 * wakeup-tools.ts (cc-parity-2 ticket 06): the schedule_wakeup tool surface —
 * schema shape, clamp (loud, not rejecting), stop, no-active-loop guard, and
 * the dynamic re-arm from the last-fired snapshot.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { WakeupRegistry } from "../src/wakeup-registry.js";
import { clampDelaySeconds, createScheduleWakeupTool } from "../src/wakeup-tools.js";

const T0 = Date.parse("2026-08-23T12:00:00Z");

test("clampDelaySeconds: in-range passes; out-of-range clamps both ways", () => {
  assert.deepEqual(clampDelaySeconds(300), { value: 300, clamped: false });
  assert.deepEqual(clampDelaySeconds(10), { value: 60, clamped: true });
  assert.deepEqual(clampDelaySeconds(3601), { value: 3600, clamped: true });
  assert.deepEqual(clampDelaySeconds(-5), { value: 60, clamped: true });
  assert.deepEqual(clampDelaySeconds(Number.NaN), { value: 60, clamped: true });
});

type Exec = (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;

function toolFor(registry: WakeupRegistry, activeId: string | undefined) {
  const t = createScheduleWakeupTool({
    registry,
    currentLoopId: () => activeId,
    now: () => new Date(T0),
  }) as unknown as { name: string; description: string; execute: Exec };
  return t;
}

test("tool: schema name + gating family membership", () => {
  const t = createScheduleWakeupTool({ registry: new WakeupRegistry(), currentLoopId: () => undefined });
  const def = t as unknown as { name: string; gating?: { gate: string } };
  assert.equal(def.name, "schedule_wakeup");
  assert.equal(def.gating?.gate, "workflow", "joins the workflow gate family (spec §2)");
});

test("tool: no active loop → loud no-op, nothing scheduled", async () => {
  const registry = new WakeupRegistry();
  const t = toolFor(registry, undefined);
  const r = await t.execute("t1", { delaySeconds: 300, reason: "waiting on CI" });
  assert.match(r.content[0]!.text, /No \/loop is active/);
  assert.equal(registry.list().length, 0);
});

test("tool: stop cancels the pending wakeup", async () => {
  const registry = new WakeupRegistry();
  registry.schedule({ id: "loop-1", prompt: "p", mode: "dynamic", dueAt: T0 + 60_000 });
  const t = toolFor(registry, "loop-1");
  const r = await t.execute("t1", { delaySeconds: 300, reason: "done", stop: true });
  assert.match(r.content[0]!.text, /stopped/i);
  assert.equal(registry.list().length, 0);
});

test("tool: re-arms a FIRED dynamic loop from the last-fired snapshot (prompt + fireCount preserved)", async () => {
  const registry = new WakeupRegistry();
  registry.schedule({ id: "loop-1", prompt: "watch the deploy", mode: "dynamic", dueAt: T0 - 1 });
  registry.due(new Date(T0)); // the tick swept it — pending gone, snapshot kept
  const t = toolFor(registry, "loop-1");
  const r = await t.execute("t1", { delaySeconds: 90, reason: "deploy still rolling" });
  assert.match(r.content[0]!.text, /re-armed/i);
  assert.match(r.content[0]!.text, /in 90s/);
  const entry = registry.get("loop-1")!;
  assert.ok(entry, "re-armed as a pending wakeup");
  assert.equal(entry.prompt, "watch the deploy", "the ORIGINAL prompt survives the re-arm");
  assert.equal(entry.mode, "dynamic");
  assert.equal(entry.dueAt, T0 + 90_000);
  assert.equal(entry.lastReason, "deploy still rolling");
});

test("tool: out-of-range delay clamps with a loud message", async () => {
  const registry = new WakeupRegistry();
  registry.schedule({ id: "loop-1", prompt: "p", mode: "dynamic", dueAt: T0 + 60_000 });
  const t = toolFor(registry, "loop-1");
  const r = await t.execute("t1", { delaySeconds: 5, reason: "too eager" });
  assert.match(r.content[0]!.text, /clamped to 60/);
  assert.equal(registry.get("loop-1")!.dueAt, T0 + 60_000);
});
