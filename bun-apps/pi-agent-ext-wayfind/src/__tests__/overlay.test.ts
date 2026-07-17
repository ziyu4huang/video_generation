import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { WayfindOverlay } from "../overlay.js";

const plainTheme = {} as Theme;

describe("WayfindOverlay", () => {
  test("renders nothing before setLine is called", () => {
    const o = new WayfindOverlay();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("renders the last line set via setLine", () => {
    const o = new WayfindOverlay();
    o.setLine("grill-me active: auth redesign");
    expect(o.render(plainTheme, 80)).toEqual(["grill-me active: auth redesign"]);
  });

  test("setLine calls the refresh callback", () => {
    const o = new WayfindOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("wayfinder: charting auth-redesign");
    expect(refreshed).toBe(1);
  });

  test("dispose clears the line", () => {
    const o = new WayfindOverlay();
    o.setLine("grill ended");
    o.dispose();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });
});
