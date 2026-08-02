import { test } from "bun:test";
import assert from "node:assert/strict";
import { getPanelEntries, type PresenceDeps } from "./presence.js";

const deps = (overrides: Partial<PresenceDeps> = {}): PresenceDeps => ({
  isGoalActive: () => false,
  getTodoCount: () => 0,
  isWayfindActive: () => false,
  ...overrides,
});

test("all absent → empty list", () => {
  assert.deepEqual(getPanelEntries(deps()), []);
});

test("goal present → first entry, command '/goal'", () => {
  const e = getPanelEntries(deps({ isGoalActive: () => true }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "goal");
  assert.equal(e[0].command, "/goal");
});

test("todo present → command '/todos'", () => {
  const e = getPanelEntries(deps({ getTodoCount: () => 3 }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "todo");
  assert.equal(e[0].command, "/todos");
});

test("wayfind present → command '/wayfind status'", () => {
  const e = getPanelEntries(deps({ isWayfindActive: () => true }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "wayfind");
  assert.equal(e[0].command, "/wayfind status");
});

test("order is goal, todo, wayfind when all present", () => {
  const e = getPanelEntries(deps({ isGoalActive: () => true, getTodoCount: () => 1, isWayfindActive: () => true }));
  assert.deepEqual(e.map((x) => x.id), ["goal", "todo", "wayfind"]);
});

test("todo count of 0 is absent (hidden)", () => {
  assert.equal(getPanelEntries(deps({ getTodoCount: () => 0 })).length, 0);
});
