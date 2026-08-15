/**
 * shell-views.test.ts — headless client-logic tests for the view notifications
 * (effort 2026-08-16 webui-view-notifications, ticket 07): age-gate, toast
 * stack rules, 24h×8 panel windowing + re-open float, dismiss overlay, poll
 * backstop merge — plus string-grid asserts that the inline RENDER_SHELL_HTML
 * script duplicates the same pinned literals (no DOM harness in this suite).
 */
import { describe, expect, it } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
import {
  TOAST_FADE_MS,
  TOAST_FRESH_MS,
  TOAST_MIN_RESUME_MS,
  TOAST_STACK_CAP,
  VIEWS_COLLAPSED_KEY,
  VIEWS_PANEL_CAP,
  VIEWS_PANEL_MAX_AGE_MS,
  dismissApply,
  isToastFresh,
  mergePolledViews,
  toastResumeMs,
  toastStackApply,
  viewOpenedId,
  viewsPanelApply,
  viewsPanelVisible,
  viewsPanelWindow,
  type ShellViewEntry,
  type ViewOpenedFrame,
  type ViewSummary,
} from "../src/shell-views.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const frame = (over: Partial<ViewOpenedFrame> = {}): ViewOpenedFrame => ({
  type: "view_opened",
  view: "arch",
  title: "Arch diagram",
  url: "/files/0/a.html",
  ts: NOW,
  ...over,
});

const entry = (id: string, updatedAt: number, url?: string): ShellViewEntry => ({
  id,
  title: id,
  url,
  updatedAt,
});

describe("shell-views constants (03-B / 04-C defaults)", () => {
  it("pins the toast + panel numbers", () => {
    expect(TOAST_FRESH_MS).toBe(10_000);
    expect(TOAST_FADE_MS).toBeGreaterThanOrEqual(6_000);
    expect(TOAST_FADE_MS).toBeLessThanOrEqual(8_000);
    expect(TOAST_FADE_MS).toBe(7_000);
    expect(TOAST_STACK_CAP).toBe(3);
    expect(VIEWS_PANEL_MAX_AGE_MS).toBe(24 * HOUR);
    expect(VIEWS_PANEL_CAP).toBe(8);
    expect(TOAST_MIN_RESUME_MS).toBeGreaterThan(0);
  });

  it("uses the agreed localStorage key mirroring the btw precedent", () => {
    expect(VIEWS_COLLAPSED_KEY).toBe("webui-views-collapsed");
  });
});

describe("isToastFresh — age-gate", () => {
  it("fresh frames toast", () => {
    expect(isToastFresh(NOW - 9_999, NOW)).toBe(true);
    expect(isToastFresh(NOW, NOW)).toBe(true);
  });

  it("stale/replayed frames (>= 10s old) never toast — panel only", () => {
    expect(isToastFresh(NOW - 10_000, NOW)).toBe(false);
    expect(isToastFresh(NOW - 5 * HOUR, NOW)).toBe(false);
  });

  it("future ts (clock skew) still counts as fresh", () => {
    expect(isToastFresh(NOW + 5_000, NOW)).toBe(true);
  });
});

describe("toastResumeMs — hover-persist", () => {
  it("resumes the REMAINING fade after pointer-over pauses it", () => {
    expect(toastResumeMs(NOW + 3_000, NOW)).toBe(3_000);
    expect(toastResumeMs(NOW + 300, NOW)).toBe(300);
  });

  it("floors at TOAST_MIN_RESUME_MS so a late pointer-leave still shows a beat", () => {
    expect(toastResumeMs(NOW - 500, NOW)).toBe(TOAST_MIN_RESUME_MS);
    expect(toastResumeMs(NOW, NOW)).toBe(TOAST_MIN_RESUME_MS);
  });
});

describe("toastStackApply — cap 3 + dedupe-extends", () => {
  it("same-view re-open EXTENDS the live toast instead of stacking", () => {
    const a = { id: "url:arch" };
    const b = { id: "url:map" };
    const next = toastStackApply([a, b], { id: "url:arch" });
    expect(next).toHaveLength(2);
    expect(next.map((t) => t.id)).toEqual(["url:map", "url:arch"]); // refreshed at newest position
  });

  it("drops the OLDEST when the stack exceeds cap 3", () => {
    const s0 = toastStackApply([], { id: "a" });
    const s1 = toastStackApply(s0, { id: "b" });
    const s2 = toastStackApply(s1, { id: "c" });
    const s3 = toastStackApply(s2, { id: "d" });
    expect(s3).toHaveLength(TOAST_STACK_CAP);
    expect(s3.map((t) => t.id)).toEqual(["b", "c", "d"]);
  });

  it("dedupe keeps the stack under cap without dropping anything", () => {
    let s = toastStackApply([], { id: "a" });
    s = toastStackApply(s, { id: "b" });
    s = toastStackApply(s, { id: "c" });
    s = toastStackApply(s, { id: "a" }); // re-open of the oldest, while stack is full
    expect(s.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("viewOpenedId — spec 02-A id-stability mirror", () => {
  it("prefers the view name; falls back to the path-absolute url", () => {
    expect(viewOpenedId("arch", "/files/0/a.html")).toBe("url:arch");
    expect(viewOpenedId(undefined, "/files/0/a.html")).toBe("url:/files/0/a.html");
  });

  it("same inputs -> same id (a re-open lands on the SAME registry row)", () => {
    expect(viewOpenedId("arch", "/files/0/old.html")).toBe(viewOpenedId("arch", "/files/0/new.html"));
  });
});

describe("viewsPanelWindow — 24h×8 windowing", () => {
  it("keeps only entries younger than 24h, newest-first, capped at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`v${i}`, NOW - i * HOUR));
    const out = viewsPanelWindow(many, NOW);
    expect(out).toHaveLength(VIEWS_PANEL_CAP);
    expect(out[0].id).toBe("v0"); // newest first
    expect(out[7].id).toBe("v7"); // cap cuts the oldest tail
    const stale = viewsPanelWindow([entry("old", NOW - 24 * HOUR), entry("edge", NOW - 24 * HOUR + 1)], NOW);
    expect(stale.map((e) => e.id)).toEqual(["edge"]); // strictly < 24h
  });

  it("sorts unordered input newest-first", () => {
    const out = viewsPanelWindow([entry("mid", NOW - 5 * HOUR), entry("new", NOW), entry("old", NOW - 10 * HOUR)], NOW);
    expect(out.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("viewsPanelApply — frame -> panel", () => {
  it("prepends newest-first; a re-open floats the entry to top without duplicating", () => {
    let panel = viewsPanelApply([], frame({ view: "a", url: "/files/0/a.html", ts: NOW - 2 * HOUR }), NOW);
    panel = viewsPanelApply(panel, frame({ view: "b", url: "/files/0/b.html", ts: NOW - 1 * HOUR }), NOW);
    expect(panel.map((e) => e.id)).toEqual(["url:b", "url:a"]);
    panel = viewsPanelApply(panel, frame({ view: "a", url: "/files/0/a2.html", ts: NOW }), NOW);
    expect(panel.map((e) => e.id)).toEqual(["url:a", "url:b"]); // floated, single entry
    expect(panel[0].url).toBe("/files/0/a2.html"); // url refreshed
    expect(panel[0].updatedAt).toBe(NOW); // bump floats it
  });

  it("drops frames older than the 24h window (ancient replays never panel)", () => {
    const panel = viewsPanelApply([], frame({ ts: NOW - 25 * HOUR }), NOW);
    expect(panel).toHaveLength(0);
  });

  it("normalizes an absent title to null", () => {
    const [row] = viewsPanelApply([], frame({ title: undefined }), NOW);
    expect(row.title).toBeNull();
  });
});

describe("dismissApply + viewsPanelVisible — client-side overlay", () => {
  it("dismiss hides the row client-side only; idempotent; others untouched", () => {
    const d0 = dismissApply([], "url:a");
    const d1 = dismissApply(d0, "url:a");
    const d2 = dismissApply(d1, "url:b");
    expect(d2.sort()).toEqual(["url:a", "url:b"]);
    const visible = viewsPanelVisible([entry("url:a", NOW), entry("url:b", NOW)], d2, NOW);
    expect(visible.map((e) => e.id)).toEqual([]); // all dismissed -> empty window => collapsed
  });

  it("empty window (no fresh entries at all) also yields zero visible rows", () => {
    expect(viewsPanelVisible([entry("url:a", NOW - 30 * HOUR)], [], NOW)).toHaveLength(0);
  });
});

describe("mergePolledViews — /api/views backstop", () => {
  const urlSummary = (id: string, updatedAt: number, title: string | null = null): ViewSummary => ({
    id,
    title,
    mode: "url",
    updatedAt,
  });

  it("bumps title/updatedAt of known rows but NEVER invents or overwrites a url", () => {
    const seeded = [entry("url:arch", NOW - HOUR, "/files/0/a.html")];
    const out = mergePolledViews(seeded, [urlSummary("url:arch", NOW, "New title")], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("/files/0/a.html"); // frame-fed url survives
    expect(out[0].title).toBe("New title");
    expect(out[0].updatedAt).toBe(NOW);
  });

  it("adds poll-only rows WITHOUT a url (title-only; open/copy disabled downstream)", () => {
    const out = mergePolledViews([], [urlSummary("url:ghost", NOW, "Ghost")], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBeUndefined();
    expect(out[0].title).toBe("Ghost");
  });

  it("ignores non-url (md/html) summaries — only url views belong to the panel", () => {
    const out = mergePolledViews(
      [],
      [{ id: "main", title: "Main", mode: "md", updatedAt: NOW }],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it("keeps a lower polled updatedAt (never regresses on clock skew)", () => {
    const seeded = [entry("url:arch", NOW, "/files/0/a.html")];
    const out = mergePolledViews(seeded, [urlSummary("url:arch", NOW - HOUR)], NOW);
    expect(out[0].updatedAt).toBe(NOW);
  });
});

describe("RENDER_SHELL_HTML embeds the inline twin (no DOM harness — string grid)", () => {
  it("carries the toast stack + views panel containers", () => {
    expect(RENDER_SHELL_HTML).toContain('id="webui-view-toasts"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-views-panel"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-views-list"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-views-collapse"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-views-count"');
  });

  it("dispatches view_opened frames and pins the age-gate + toast literals", () => {
    expect(RENDER_SHELL_HTML).toContain("case 'view_opened':");
    expect(RENDER_SHELL_HTML).toContain("VIEW_TOAST_FRESH_MS = 10000");
    expect(RENDER_SHELL_HTML).toContain("VIEW_TOAST_FADE_MS = 7000");
    expect(RENDER_SHELL_HTML).toContain("VIEW_TOAST_CAP = 3");
    expect(RENDER_SHELL_HTML).toContain("is not input"); // mutex: display-only rationale
  });

  it("persists the collapse state under the agreed key (btw precedent)", () => {
    expect(RENDER_SHELL_HTML).toContain("webui-views-collapsed");
    expect(RENDER_SHELL_HTML).toContain("localStorage.getItem('webui-views-collapsed')");
  });

  it("routes url-mode tabs to openViewUrl — never into the sandbox iframe", () => {
    expect(RENDER_SHELL_HTML).toContain("if (v.mode === 'url')");
    expect(RENDER_SHELL_HTML).toContain("openViewUrl(entry.url)");
    // guardrail comment next to the tab branch
    expect(RENDER_SHELL_HTML).toContain("02-A guardrail");
  });

  it("uses the per-URL window handle (open once, focus after)", () => {
    expect(RENDER_SHELL_HTML).toContain("viewUrlHandles[url] = window.open(url, '_blank')");
    expect(RENDER_SHELL_HTML).toContain("h.focus()");
  });

  it("polls /api/views at 1s only while expanded, and copies via clipboard", () => {
    expect(RENDER_SHELL_HTML).toContain("setInterval(viewsPollTick, 1000)");
    expect(RENDER_SHELL_HTML).toContain("navigator.clipboard.writeText(location.origin + e.url)");
  });
});
