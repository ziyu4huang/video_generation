import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WayfindState } from "../overlay.js";
import { WayfindOverlay } from "../overlay.js";

const plainTheme = {} as Theme;

describe("WayfindOverlay", () => {
  test("renders nothing before setLine is called", () => {
    const o = new WayfindOverlay();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("setLine composes the branded status-bar frame + state emoji + text", () => {
    const o = new WayfindOverlay();
    o.setLine("grilling", "auth redesign");
    // Status-bar shape: brand │ emoji text — instantly distinguishable from plain log lines.
    expect(o.render(plainTheme, 80)).toEqual(["🧭 wayfind │ 🔥 auth redesign"]);
  });

  // The state→emoji map IS the feature; assert every state renders its emoji.
  test.each([
    ["grilling", "🔥"],
    ["grilling-docs", "📚"],
    ["charting", "🗺️"],
    ["working-ticket", "🎯"],
    ["to-tickets", "🎫"],
    ["to-spec", "📝"],
    ["seed", "🌱"],
    ["domain-modeling", "🧩"],
    ["sync", "🔗"],
    ["done", "✅"],
  ] as [WayfindState, string][])("state %s renders its emoji %s", (state, emoji) => {
    const o = new WayfindOverlay();
    o.setLine(state, "x");
    expect(o.render(plainTheme, 80)[0]).toContain(emoji);
  });

  test("setLine calls the refresh callback", () => {
    const o = new WayfindOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("charting", "auth-redesign");
    expect(refreshed).toBe(1);
  });

  test("dispose clears the line", () => {
    const o = new WayfindOverlay();
    o.setLine("done", "effort");
    o.dispose();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });
});
