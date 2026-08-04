import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEffortMeta, readMap, writeMap } from "../src/map.js";
import type { StatusReport } from "../src/wayfinder.js";
import {
  addTicket,
  chartMap,
  claimNextTicket,
  closeEffortReflection,
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

  it("chartMap writes an 'active' manifest so the status overlay doesn't show '(no manifest)'", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "a spec for the orders service");
    const meta = readEffortMeta(cwd, "orders");
    expect(meta).not.toBeNull();
    expect(meta?.effort).toBe("orders");
    expect(meta?.status).toBe("active");
    expect(meta?.created).toBe(new Date().toISOString().slice(0, 10));
  });

  it("chartMap preserves a legacy map's lack of front-matter on re-chart (byte-compat)", () => {
    const cwd = makeCwd();
    // Seed a legacy prose-only map.md (no front-matter), as the ~377 existing efforts.
    const dir = join(cwd, ".planning", "legacy");
    mkdirSync(join(dir, "tickets"), { recursive: true });
    writeFileSync(
      join(dir, "map.md"),
      ["# Wayfinder map: legacy", "", "## Destination", "", "old effort", ""].join("\n"),
      "utf-8",
    );
    chartMap(cwd, "legacy", "re-charted destination");
    // Re-charting a legacy effort must NOT add front-matter (writeMap byte-compat).
    expect(readEffortMeta(cwd, "legacy")).toBeNull();
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

  it("reports a clear frontier when no open tickets remain (no nudge — nothing closed yet)", () => {
    const cwd = makeCwd();
    chartMap(cwd, "orders", "dest");
    const r = statusReport(cwd, "orders");
    if (!r) throw new Error("expected status report");
    expect(renderStatus(r)).toContain("the way is found");
    expect(renderStatus(r)).not.toContain("/wayfind done");
  });

  it("nudges /wayfind done when the frontier is clear AND tickets were closed", () => {
    const r: StatusReport = {
      effort: "e",
      destination: "d",
      open: 0,
      closed: 1,
      claimed: 0,
      frontier: [],
      fog: 0,
    };
    expect(renderStatus(r)).toContain("the way is found");
    expect(renderStatus(r)).toContain("/wayfind done");
  });
});

describe("closeEffortReflection (/wayfind done)", () => {
  it("refuses when open tickets remain on the frontier", () => {
    const cwd = makeCwd();
    chartMap(cwd, "done-demo", "dest");
    addTicket(cwd, "done-demo", "Open decision", "which?", "grilling", []);
    const r = closeEffortReflection(cwd, "done-demo");
    expect("refused" in r).toBe(true);
    if ("refused" in r) expect(r.refused).toContain("open ticket");
  });

  it("refuses when the effort has no map", () => {
    const cwd = makeCwd();
    const r = closeEffortReflection(cwd, "nonexistent");
    expect("refused" in r).toBe(true);
  });

  it("harvests fog into a next-goal note when the frontier is clear", () => {
    const cwd = makeCwd();
    chartMap(cwd, "done-demo", "ship the closing ceremony");
    const map = readMap(cwd, "done-demo");
    if (!map) throw new Error("expected a map");
    map.fog = [
      "<!-- placeholder comment the standard map template leaves in the section →",
      "Fix the deploy-verify CI gate",
      "Surface SDD status in workflow agent()",
    ];
    writeMap(cwd, map);
    // fixed timestamp → deterministic filename (local components, TZ-stable)
    const r = closeEffortReflection(cwd, "done-demo", new Date(2026, 6, 23, 3, 30, 0));
    expect("refused" in r).toBe(false);
    if ("refused" in r) throw new Error("expected a reflection, got a refusal");
    expect(r.path).toBe("output/next-goal-20260723_033000.md");
    expect(r.deferredPrizes).toEqual(["Fix the deploy-verify CI gate", "Surface SDD status in workflow agent()"]);
    expect(r.nextGoal).toBe("Fix the deploy-verify CI gate");
    const note = readFileSync(join(cwd, r.path), "utf-8");
    expect(note).toContain("ship the closing ceremony"); // destination framing
    expect(note).toContain("1. Fix the deploy-verify CI gate"); // prize pre-filled
    expect(note).toContain("**Fix the deploy-verify CI gate**"); // next goal bolded
    // the next-goal fork MUST instruct the agent to present it via ask_user_question
    // (never a prose menu) — mirrors grilling's one-question-at-a-time discipline.
    expect(note).toContain("ask_user_question");
  });
});
