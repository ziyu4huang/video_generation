import { beforeEach, describe, expect, test } from "bun:test";
import { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";

let registry: SubagentInFlightRegistry;

beforeEach(() => {
  registry = new SubagentInFlightRegistry();
});

function start(id: string, overrides: Record<string, unknown> = {}) {
  registry.start({ id, startedAt: 1000, taskPreview: "task", ...overrides } as Parameters<typeof registry.start>[0]);
}

describe("terminal transitions", () => {
  test("markCompleted(id, 'failed') stamps status + endedAt", () => {
    start("a");
    registry.markCompleted("a", "failed");
    const v = registry.view("a");
    expect(v?.status).toBe("failed");
    expect(typeof v?.elapsedFrozen).toBe("boolean");
    expect(registry.get("a")?.endedAt).toBeGreaterThan(0);
  });

  test("markCompleted defaults to done (legacy no-arg)", () => {
    start("a");
    registry.markCompleted("a");
    expect(registry.get("a")?.status).toBe("done");
    expect(registry.get("a")?.endedAt).toBeGreaterThan(0);
  });

  test("markFailed defaults to failed and stamps endedAt", () => {
    start("a");
    registry.markFailed("a");
    expect(registry.get("a")?.status).toBe("failed");
    expect(registry.get("a")?.endedAt).toBeGreaterThan(0);

    registry.markFailed("a", "timedout");
    expect(registry.get("a")?.status).toBe("timedout");
  });
});

test("updateTaskPreview overwrites the preview", () => {
  start("a");
  registry.updateTaskPreview("a", "new preview");
  expect(registry.view("a")?.latestAction).toBe("new preview");
});

test("views({foreground:false}) filters to background runs; no opts returns all", () => {
  start("bg1");
  start("fg1", { foreground: true });
  expect(registry.views({ foreground: false }).map((v) => v.id)).toEqual(["bg1"]);
  expect(registry.views({ foreground: true }).map((v) => v.id)).toEqual(["fg1"]);
  expect(
    registry
      .views()
      .map((v) => v.id)
      .sort(),
  ).toEqual(["bg1", "fg1"]);
});

test("legacy start({status:'completed'}) coerces to 'done'", () => {
  start("legacy", { status: "completed" });
  expect(registry.view("legacy")?.status).toBe("done");
});

test("start defaults omitted status to 'running'", () => {
  expect(registry.view("a")?.status).toBeUndefined();
  start("a");
  expect(registry.view("a")?.status).toBe("running");
});
