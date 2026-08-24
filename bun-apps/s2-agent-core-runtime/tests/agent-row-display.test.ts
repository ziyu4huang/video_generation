import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityStatus } from "../src/agent-row-display.js";
import {
  activityGlyph,
  fmtDurationHuman,
  fmtElapsed,
  fmtTokens,
  glyphFor,
  NO_THEME,
  preview,
  renderBadge,
  renderRunRow,
  runHeader,
  shorten,
} from "../src/agent-row-display.js";
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

// ── width-aware shorten/preview (2026-08-19 core-runtime width adoption) ──
// Signatures unchanged: the `max` argument becomes a terminal-COLUMN budget
// (CJK double-width counted) instead of a char count. ASCII outputs stay
// byte-identical to the legacy char-slice; wide-char inputs never overshoot.

describe("shorten / preview — column-aware budgets", () => {
  test("shorten: ASCII output byte-identical to legacy char-slice", () => {
    expect(shorten("x".repeat(100), 50)).toBe(`${"x".repeat(49)}…`);
    expect(shorten("fits", 50)).toBe("fits");
  });

  test("shorten: CJK clipped by columns, wide char never straddles the budget", () => {
    const out = shorten("你".repeat(60), 50); // 120 columns
    expect(out).toBe(`${"你".repeat(24)}…`); // 24×2 + 1 = 49 columns
  });

  test("preview: ASCII output byte-identical; default cap 80", () => {
    expect(preview("y".repeat(100))).toBe(`${"y".repeat(79)}…`);
    expect(preview("ok")).toBe("ok");
  });

  test("preview: CJSON/CJK payload clipped by columns, never overshoot", () => {
    const out = preview({ note: "你".repeat(100) }, 40);
    expect(visibleWidth(out)).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ── CC-parity formatting helpers (tui-cc-parity ticket 01) ──

describe("fmtDurationHuman — CC vocabulary (45s / 2m 13s / 1h 04m)", () => {
  test("sub-second keeps one decimal", () => {
    expect(fmtDurationHuman(830)).toBe("0.8s");
  });
  test("sub-minute is whole seconds", () => {
    expect(fmtDurationHuman(45_000)).toBe("45s");
    expect(fmtDurationHuman(59_900)).toBe("59s");
  });
  test("minutes carry zero-padded seconds", () => {
    expect(fmtDurationHuman(133_000)).toBe("2m 13s");
    expect(fmtDurationHuman(65_000)).toBe("1m 05s");
  });
  test("hours carry zero-padded minutes", () => {
    expect(fmtDurationHuman(3_600_000)).toBe("1h 00m");
    expect(fmtDurationHuman(3_840_000 + 5_000)).toBe("1h 04m");
  });
  test("degenerate inputs clamp to 0s", () => {
    expect(fmtDurationHuman(-5)).toBe("0s");
    expect(fmtDurationHuman(Number.NaN)).toBe("0s");
  });
  test("fmtElapsed stays the stable-width live form (unchanged)", () => {
    expect(fmtElapsed(45_000)).toBe("45.0s");
  });
});

describe("fmtTokens — separator'd count (34,283)", () => {
  test("groups thousands", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1_000)).toBe("1,000");
    expect(fmtTokens(34_283)).toBe("34,283");
    expect(fmtTokens(1_200_000)).toBe("1,200,000");
  });
  test("degenerate inputs clamp to 0", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(-3)).toBe("0");
    expect(fmtTokens(Number.NaN)).toBe("0");
  });
});
