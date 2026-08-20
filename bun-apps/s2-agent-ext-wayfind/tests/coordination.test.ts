import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncChainState } from "../src/chain.js";
import { readPlanIncomplete, readPlanSummary } from "../src/coordination.js";
import { readMap, writeMap, writeTicket } from "../src/map.js";

describe("readPlanIncomplete / readPlanSummary (plan-coordinator seam)", () => {
  it("graceful fallback when the plan coordinator is absent", () => {
    delete (globalThis as Record<string, unknown>).__piPlanIncomplete;
    delete (globalThis as Record<string, unknown>).__piPlanSummary;
    expect(readPlanIncomplete("/any/cwd")).toBe(false);
    expect(readPlanSummary("/any/cwd")).toBe("");
  });

  it("reads the published functions when present", () => {
    (globalThis as Record<string, unknown>).__piPlanIncomplete = () => true;
    (globalThis as Record<string, unknown>).__piPlanSummary = () => "2/4 phases";
    expect(readPlanIncomplete("/any/cwd")).toBe(true);
    expect(readPlanSummary("/any/cwd")).toBe("2/4 phases");
    delete (globalThis as Record<string, unknown>).__piPlanIncomplete;
    delete (globalThis as Record<string, unknown>).__piPlanSummary;
  });
});

// ─── syncChainState (ADR-wayfind-0003 feedback half: close tickets whose phase completed) ──
describe("syncChainState (ADR-wayfind-0003: close tickets whose phase completed)", () => {
  const PHASES_KEY = "__piPlanPhases";
  const tempRoots: string[] = [];

  function makeCwd(): string {
    const c = mkdtempSync(join(tmpdir(), "wf-chain-"));
    tempRoots.push(c);
    return c;
  }
  function seed(cwd: string, effort: string): void {
    writeMap(cwd, {
      effort,
      destination: "demo",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    writeTicket(cwd, effort, {
      id: "03",
      slug: "foo",
      title: "Foo",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });
    writeTicket(cwd, effort, {
      id: "05",
      slug: "bar",
      title: "Bar",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PHASES_KEY];
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the ticket whose phase is complete; leaves in-progress open; appends a decision", () => {
    const cwd = makeCwd();
    const effort = "demo";
    seed(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "completed", ticketIds: ["03-foo"] },
      { id: "2", status: "in_progress" },
    ];

    const r = syncChainState(cwd, effort);
    expect(r.closed).toEqual(["03-foo"]);

    const map = readMap(cwd, effort);
    const foo = map?.tickets.find((t) => t.id === "03");
    const bar = map?.tickets.find((t) => t.id === "05");
    expect(foo?.status).toBe("closed");
    expect(foo?.resolution).toBeTruthy();
    expect(bar?.status).toBe("open");
    expect(map?.decisions.some((d) => d.title === "Foo")).toBe(true);
  });

  it("is idempotent: a second call closes nothing new and adds no duplicate decision", () => {
    const cwd = makeCwd();
    const effort = "demo";
    seed(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "completed", ticketIds: ["03-foo"] },
    ];
    syncChainState(cwd, effort);
    const r2 = syncChainState(cwd, effort);
    expect(r2.closed).toEqual([]);
    const map = readMap(cwd, effort);
    expect(map?.decisions.filter((d) => d.title === "Foo").length).toBe(1);
  });

  it("matches by bare id too (a [03] ref closes ticket 03, not just the [03-foo] stem)", () => {
    const cwd = makeCwd();
    const effort = "demo";
    seed(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [{ id: "1", status: "completed", ticketIds: ["03"] }];
    expect(syncChainState(cwd, effort).closed).toEqual(["03"]);
  });

  it("is a graceful no-op when __piPlanPhases is undefined (no plan coordinator)", () => {
    const cwd = makeCwd();
    const effort = "demo";
    seed(cwd, effort);
    delete (globalThis as Record<string, unknown>)[PHASES_KEY];
    const r = syncChainState(cwd, effort);
    expect(r.closed).toEqual([]);
    expect(readMap(cwd, effort)?.tickets.every((t) => t.status === "open")).toBe(true);
  });

  it("skips refs that match no ticket (no throw) and reports them as skipped", () => {
    const cwd = makeCwd();
    const effort = "demo";
    seed(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "completed", ticketIds: ["99-missing"] },
    ];
    const r = syncChainState(cwd, effort);
    expect(r.closed).toEqual([]);
    expect(r.skipped).toEqual(["99-missing"]);
  });
});
