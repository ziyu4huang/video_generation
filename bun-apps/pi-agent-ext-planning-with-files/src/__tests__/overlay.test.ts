import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PlanningOverlay } from "../overlay.js";

const plainTheme = {} as Theme;

describe("PlanningOverlay", () => {
  test("renders nothing before setLine is called", () => {
    const o = new PlanningOverlay();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("renders the last line set via setLine", () => {
    const o = new PlanningOverlay();
    o.setLine("2/4 phases complete");
    expect(o.render(plainTheme, 80)).toEqual(["2/4 phases complete"]);
  });

  test("setLine calls the refresh callback", () => {
    const o = new PlanningOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("No active plan");
    expect(refreshed).toBe(1);
  });

  test("dispose clears the line", () => {
    const o = new PlanningOverlay();
    o.setLine("Plan closed (via /plan-done)");
    o.dispose();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });
});
