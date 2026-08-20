import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { writeMap } from "../map.js";
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

describe("WayfindOverlay — transient action line + manifest augmentation", () => {
  test("renders NOTHING when idle, even with an active effort (clean status bar)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, {
      effort: "demo",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "demo", status: "active" },
    });
    const o = new WayfindOverlay();
    o.setActiveEffort("demo", cwd);
    // Idle (no transient action) → no wayfind line: the status bar stays clean.
    expect(o.render({} as Theme, 80)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("renders nothing when idle even for a legacy (no-manifest) active effort", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    const o = new WayfindOverlay();
    o.setActiveEffort("legacy", cwd);
    expect(o.render({} as Theme, 80)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("renders nothing when there is no active effort and no transient state", () => {
    const o = new WayfindOverlay();
    expect(o.render({} as Theme, 80)).toEqual([]);
  });

  test("a transient action line is augmented with the active effort's manifest status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    writeMap(cwd, {
      effort: "demo",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "demo", status: "active" },
    });
    const o = new WayfindOverlay();
    o.setActiveEffort("demo", cwd);
    o.setLine("charting", "charting demo");
    // Augmented: the manifest status shows ALONGSIDE the transient action (not
    // only when idle) — so an active effort's status is always visible.
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ charting demo · active"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a transient action with NO active effort renders the plain action line (no status)", () => {
    const o = new WayfindOverlay();
    o.setLine("charting", "charting demo");
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ charting demo"]);
  });

  test("render never throws when the manifest file becomes unreadable (concurrent write/removal)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-ov-"));
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(join(dir, "tickets"), { recursive: true });
    // map.md as a DIRECTORY → existsSync true, readFileSync throws EISDIR,
    // exercising the TOCTOU window (file present at existsSync, gone/unreadable at read).
    mkdirSync(join(dir, "map.md"), { recursive: true });
    // augmented-activity branch: must not throw, falls back to (no manifest).
    const o = new WayfindOverlay();
    o.setActiveEffort("demo", cwd);
    o.setLine("charting", "charting demo");
    expect(() => o.render({} as Theme, 80)).not.toThrow();
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🗺️ charting demo · (no manifest)"]);
    // idle: renders nothing (no idle line) but still must not throw.
    const idle = new WayfindOverlay();
    idle.setActiveEffort("demo", cwd);
    expect(() => idle.render({} as Theme, 80)).not.toThrow();
    expect(idle.render({} as Theme, 80)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("WayfindOverlay — clearTransientUnlessSustained (turn_end auto-clear)", () => {
  test("clears a one-shot state (charting) so the bar goes clean", () => {
    const o = new WayfindOverlay();
    o.setLine("charting", "charting demo");
    expect(o.render({} as Theme, 80)[0]).toContain("charting demo");
    o.clearTransientUnlessSustained();
    expect(o.render({} as Theme, 80)).toEqual([]);
  });

  test("leaves a sustained state (grilling) intact", () => {
    const o = new WayfindOverlay();
    o.setLine("grilling", "auth redesign");
    o.clearTransientUnlessSustained();
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 🔥 auth redesign"]);
  });

  test("leaves grilling-docs intact (also sustained)", () => {
    const o = new WayfindOverlay();
    o.setLine("grilling-docs", "auth redesign (docs)");
    o.clearTransientUnlessSustained();
    expect(o.render({} as Theme, 80)).toEqual(["🧭 wayfind │ 📚 auth redesign (docs)"]);
  });

  test("is a no-op (no throw) when no transient is set", () => {
    const o = new WayfindOverlay();
    expect(() => o.clearTransientUnlessSustained()).not.toThrow();
    expect(o.render({} as Theme, 80)).toEqual([]);
  });

  test("calls the refresh callback when it clears a one-shot state", () => {
    const o = new WayfindOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("charting", "x"); // +1
    o.clearTransientUnlessSustained(); // +1 (cleared)
    expect(refreshed).toBe(2);
  });

  test("does NOT refresh when the state is sustained (nothing changed)", () => {
    const o = new WayfindOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("grilling", "x"); // +1
    o.clearTransientUnlessSustained(); // no-op → no refresh
    expect(refreshed).toBe(1);
  });
});

describe("WayfindOverlay — opt-in persistent status bar", () => {
  /** Build a tmp cwd with a manifest map carrying the given effort + status. */
  function cwdWithEffort(effort: string, status: "active" | "complete" | "paused"): string {
    const cwd = mkdtempSync(join(tmpdir(), "wf-sb-"));
    writeMap(cwd, {
      effort,
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort, status },
    });
    return cwd;
  }

  test("statusBarOn=true + active effort (status active) → paints the idle effort line", () => {
    const cwd = cwdWithEffort("demo", "active");
    const o = new WayfindOverlay();
    o.setStatusBarEnabled(true);
    o.setActiveEffort("demo", cwd);
    expect(o.render(plainTheme, 80)).toEqual(["🧭 wayfind │ 🗺️ demo · active"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("statusBarOn=true + status complete → [] (auto-hides a completed effort)", () => {
    const cwd = cwdWithEffort("demo", "complete");
    const o = new WayfindOverlay();
    o.setStatusBarEnabled(true);
    o.setActiveEffort("demo", cwd);
    expect(o.render(plainTheme, 80)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("statusBarOn=true + no active effort → [] (nothing to show)", () => {
    const o = new WayfindOverlay();
    o.setStatusBarEnabled(true);
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("statusBarOn=true + a transient action line set → renders the transient line, NOT the idle line (precedence)", () => {
    const cwd = cwdWithEffort("demo", "active");
    const o = new WayfindOverlay();
    o.setStatusBarEnabled(true);
    o.setActiveEffort("demo", cwd);
    o.setLine("charting", "charting demo");
    // The transient action line wins (augmented with manifest status), never the idle effort line.
    expect(o.render(plainTheme, 80)).toEqual(["🧭 wayfind │ 🗺️ charting demo · active"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("statusBarOn=false (default) + active effort → [] (the gating fix — idle line never monopolizes the bar)", () => {
    const cwd = cwdWithEffort("demo", "active");
    const o = new WayfindOverlay();
    // statusBarOn stays false (default — tests construct WayfindOverlay directly).
    o.setActiveEffort("demo", cwd);
    expect(o.render(plainTheme, 80)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("setStatusBarEnabled(true) flips state + triggers refresh; isStatusBarEnabled reflects it", () => {
    const o = new WayfindOverlay();
    expect(o.isStatusBarEnabled()).toBe(false);
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setStatusBarEnabled(true);
    expect(o.isStatusBarEnabled()).toBe(true);
    expect(refreshed).toBe(1);
  });
});
