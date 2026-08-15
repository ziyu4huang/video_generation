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
    expect(v?.elapsedFrozen).toBe(true);
  });

  test("markCompleted defaults to done (legacy no-arg)", () => {
    start("a");
    registry.markCompleted("a");
    const v = registry.view("a");
    expect(v?.status).toBe("done");
    expect(v?.elapsedFrozen).toBe(true);
  });

  test("markFailed defaults to failed and stamps endedAt", () => {
    start("a");
    registry.markFailed("a");
    expect(registry.view("a")?.status).toBe("failed");
    expect(registry.view("a")?.elapsedFrozen).toBe(true);

    registry.markFailed("a", "timedout");
    expect(registry.view("a")?.status).toBe("timedout");
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

test("start accepts ActivityStatus only (no legacy 'completed' literal)", () => {
  registry.start({ id: "s1", startedAt: Date.now(), taskPreview: "task", status: "done" });
  expect(registry.view("s1")?.status).toBe("done");
});

test("start defaults omitted status to 'running'", () => {
  expect(registry.view("a")?.status).toBeUndefined();
  start("a");
  expect(registry.view("a")?.status).toBe("running");
});

describe("accrueUsage", () => {
  test("sums deltas on a live run", () => {
    start("a");
    registry.accrueUsage("a", { costUsd: 0.01, tokensIn: 10, tokensOut: 20 });
    registry.accrueUsage("a", { costUsd: 0.03, tokensIn: 90, tokensOut: 180 });
    const v = registry.view("a");
    expect(v?.costUsd).toBe(0.04);
    expect(v?.tokensIn).toBe(100);
    expect(v?.tokensOut).toBe(200);
  });

  test("ignored after terminal (freeze mirrors elapsedFrozen)", () => {
    start("a");
    registry.markCompleted("a");
    registry.accrueUsage("a", { costUsd: 0.04, tokensIn: 100, tokensOut: 200 });
    expect(registry.view("a")?.costUsd).toBe(0);
  });

  test("no-op for unknown id (never throws)", () => {
    registry.accrueUsage("nope", { costUsd: 1, tokensIn: 1, tokensOut: 1 });
  });
});
