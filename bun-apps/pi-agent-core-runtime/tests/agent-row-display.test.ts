import { describe, expect, test } from "bun:test";
import type { ActivityStatus } from "../src/agent-row-display.js";
import { activityGlyph, glyphFor, NO_THEME, renderBadge, renderRunRow, runHeader } from "../src/agent-row-display.js";
import type { RunView } from "../src/run-view.js";
import { buildRunView } from "../src/run-view.js";

const ALL_STATUSES: ActivityStatus[] = [
  "queued",
  "running",
  "done",
  "error",
  "failed",
  "skipped",
  "timedout",
  "budget",
  "turns",
  "aborted",
];

describe("glyphFor consistency", () => {
  test("for every ActivityStatus, glyphFor(s).icon === activityGlyph(s).icon", () => {
    for (const s of ALL_STATUSES) {
      expect(glyphFor(s).icon).toBe(activityGlyph(s).icon);
      expect(glyphFor(s).color).toBe(activityGlyph(s).color);
    }
  });

  test("plain glyphs are non-empty plain text for every status", () => {
    for (const s of ALL_STATUSES) {
      const { icon } = glyphFor(s, { plain: true });
      expect(icon.length).toBeGreaterThan(0);
      expect(icon).not.toMatch(/[\u2500-\u27BF]/);
    }
  });
});

describe("renderBadge / runHeader", () => {
  const base = {
    id: "r1",
    startedAt: 0,
    taskPreview: "preview",
    status: "running" as ActivityStatus,
  };

  test("renderBadge empty when no badgeText; fixed-width when present", () => {
    const v: RunView = buildRunView(base, 1000);
    expect(renderBadge(v, NO_THEME)).toBe("");
    const badged = buildRunView({ ...base, fellBack: true, requestedModel: "m" }, 1000);
    expect(renderBadge(badged, NO_THEME)).toBe("fallback");
  });

  test("runHeader is plain and contains id, elapsed, action", () => {
    const v = buildRunView(base, 4000);
    const h = runHeader(v);
    expect(h.startsWith("[r1]")).toBe(true);
    expect(h).toContain("4.0s");
    expect(h).toContain("preview");
  });
});

describe("renderRunRow — cost tail", () => {
  const base = {
    id: "r1",
    startedAt: 0,
    taskPreview: "preview",
    status: "running" as ActivityStatus,
  };

  test("appends `· $0.04` when costUsd > 0", () => {
    const v = buildRunView({ ...base, usageAccrued: { costUsd: 0.04, tokensIn: 1, tokensOut: 1 } }, 1000);
    expect(renderRunRow(v, NO_THEME)).toContain("· $0.04");
  });

  test("cost tail absent when costUsd is 0", () => {
    const v = buildRunView(base, 1000);
    expect(renderRunRow(v, NO_THEME)).not.toContain("$");
  });
});
