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

describe("markDetached (Task 05)", () => {
  test("unknown id → false (never throws)", () => {
    expect(registry.markDetached("nope")).toBe(false);
  });

  test("flips foreground=false, stamps detached=true, keeps the entry live", () => {
    start("a");
    expect(registry.markDetached("a")).toBe(true);
    const v = registry.view("a");
    expect(v).toBeDefined();
    expect(v?.foreground).toBe(false);
    expect(v?.detached).toBe(true);
    expect(v?.status).toBe("running");
  });

  test("rebinds abort to the detached child's kill lever", () => {
    start("a");
    let kills = 0;
    registry.markDetached("a", { abort: () => void kills++ });
    registry.abort("a");
    expect(kills).toBe(1);
  });

  test("onDetach fires for a subscriber registered before the flip (exactly once)", () => {
    start("a");
    let fired = 0;
    const off = registry.onDetach("a", () => void fired++);
    registry.markDetached("a");
    registry.markDetached("a"); // idempotent re-flip must not re-fire
    expect(fired).toBe(1);
    off();
  });

  test("onDetach fires immediately when the run is already detached", () => {
    start("a");
    registry.markDetached("a");
    let fired = 0;
    registry.onDetach("a", () => void fired++);
    expect(fired).toBe(1);
  });

  test("onDetach for an unknown id is a no-op subscription", () => {
    let fired = 0;
    const off = registry.onDetach("missing", () => void fired++);
    off();
    expect(fired).toBe(0);
  });
});

describe("change watchers (F-invalidate — discrete lifecycle channel)", () => {
  test("markCompleted/markFailed fire the bound invalidate AND the change watchers", () => {
    start("a");
    let invalidations = 0;
    let changes = 0;
    registry.bindInvalidate("a", () => void invalidations++);
    registry.onChange(() => void changes++);
    registry.markCompleted("a");
    expect(invalidations).toBe(1);
    expect(changes).toBe(1);

    registry.markFailed("a", "error");
    expect(invalidations).toBe(2);
    expect(changes).toBe(2);
  });

  test("start/end/markDetached fire the change watchers", () => {
    let changes = 0;
    registry.onChange(() => void changes++);
    start("a");
    expect(changes).toBe(1);
    registry.markDetached("a");
    expect(changes).toBe(2);
    registry.end("a");
    expect(changes).toBe(3);
  });

  test("endBatch fires ONCE for the whole group (watchers render state, they don't count children)", () => {
    let changes = 0;
    registry.onChange(() => void changes++);
    start("b1", { batchId: "batch-1" });
    start("b2", { batchId: "batch-1" });
    const afterStarts = changes; // 2
    registry.endBatch("batch-1");
    expect(changes).toBe(afterStarts + 1);
  });

  test("history streaming and usage accrual do NOT fire the change channel (too hot)", () => {
    let changes = 0;
    registry.onChange(() => void changes++);
    start("a");
    registry.update("a", []);
    registry.updateModel("a", "zai/glm-5.3");
    registry.accrueUsage("a", { costUsd: 0.01, tokensIn: 10, tokensOut: 5 });
    expect(changes).toBe(1, "only the start() transition fired");
  });

  test("unsubscribe stops the firing and is safe to call twice", () => {
    let changes = 0;
    const off = registry.onChange(() => void changes++);
    start("a");
    expect(changes).toBe(1);
    off();
    off();
    registry.end("a");
    expect(changes).toBe(1);
  });
});
