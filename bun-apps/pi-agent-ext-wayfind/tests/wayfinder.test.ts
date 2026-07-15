import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMap } from "../src/map.js";
import {
  addTicket,
  chartMap,
  claimNextTicket,
  renderStatus,
  resolveTicket,
  slugify,
  statusReport,
} from "../src/wayfinder.js";

const tempRoots: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wayfind-map-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("slugify", () => {
  it("hyphenates + lowercases + trims", () => {
    expect(slugify("Orders Service v2!")).toBe("orders-service-v2");
    expect(slugify("   ")).toBe("effort"); // fallback for empty
  });
});

describe("chartMap + ticket lifecycle", () => {
  it("charts a map with the destination + empty decisions/fog", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "a spec for the orders service");
    expect(existsSync(join(cwd, ".planning", "orders", "map.md"))).toBe(true);
    expect(existsSync(join(cwd, ".planning", "orders", "tickets"))).toBe(true);
    const map = readMap(cwd, "orders");
    expect(map?.destination).toBe("a spec for the orders service");
    expect(map?.decisions).toEqual([]);
  });

  it("claimNextTicket takes the first frontier ticket + stamps a claim", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "dest");
    addTicket(cwd, "orders", "Pick storage", "which db?", "grilling", []);
    addTicket(cwd, "orders", "API shape", "REST?", "grilling", ["01"]); // blocked by 01

    const claimed = claimNextTicket(cwd, "orders", "session-A");
    expect(claimed?.id).toBe("01");
    expect(claimed?.title).toBe("Pick storage");
    expect(claimed?.claimed).toBe("session-A");

    // After claiming, the frontier excludes the claimed ticket.
    const r = statusReport(cwd, "orders");
    expect(r?.frontier.map((t) => t.id)).toEqual([]); // 01 claimed, 02 blocked
    expect(r?.claimed).toBe(1);
  });

  it("resolveTicket closes the ticket + appends to Decisions so far + unblocks dependents", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "dest");
    addTicket(cwd, "orders", "Pick storage", "which db?", "grilling", []);
    addTicket(cwd, "orders", "API shape", "REST?", "grilling", ["01"]);

    const resolved = resolveTicket(cwd, "orders", "01", "Postgres for concurrency.", "Postgres");
    expect(resolved?.status).toBe("closed");
    expect(resolved?.resolution).toContain("Postgres");

    // Decision pointer landed on the map.
    const map = readMap(cwd, "orders");
    expect(map?.decisions.length).toBe(1);
    expect(map?.decisions[0].title).toBe("Pick storage");
    expect(map?.decisions[0].link).toBe("tickets/01-pick-storage.md");

    // Dependent 02 is now unblocked → on the frontier.
    const r = statusReport(cwd, "orders");
    expect(r?.frontier.map((t) => t.id)).toEqual(["02"]);
    expect(r?.open).toBe(1);
    expect(r?.closed).toBe(1);
  });

  it("claimNextTicket returns null when the frontier is empty", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "dest");
    addTicket(cwd, "orders", "blocked one", "?", "grilling", ["99"]); // blocker absent+open
    expect(claimNextTicket(cwd, "orders", "x")).toBeNull();
  });
});

describe("renderStatus", () => {
  it("renders counts + frontier titles", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "the orders spec");
    addTicket(cwd, "orders", "Pick storage", "?", "grilling", []);
    const r = statusReport(cwd, "orders");
    if (!r) throw new Error("expected status report");
    const out = renderStatus(r);
    expect(out).toContain("[orders]");
    expect(out).toContain("open 1");
    expect(out).toContain("Pick storage");
    expect(out).toContain("the orders spec");
  });

  it("reports a clear frontier when no open tickets remain", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "dest");
    const r = statusReport(cwd, "orders");
    if (!r) throw new Error("expected status report");
    expect(renderStatus(r)).toContain("the way is found");
  });
});
