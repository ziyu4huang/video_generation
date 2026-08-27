/**
 * esc-settle-detector — offline contract for the Esc-repro regression lane's
 * badge-glyph discriminator (#2067 lesson: `↳` continuation lines defeat a
 * naive live-line detector; only the settled row starts with a status badge).
 * Fixtures are REAL pane shapes: the streaming partial header
 * (formatSubagentProgress), the settled row (settledHeaderRow), and the
 * #2067 before/after receipts.
 */
import { describe, expect, test } from "bun:test";
import { BADGE_BY_STATUS, detectSettledRow, detectStreamingPartial, stripAnsi } from "../src/esc-settle-detector.js";

describe("stripAnsi", () => {
  test("removes SGR sequences; plain text untouched", () => {
    expect(stripAnsi("\x1b[31m⊘ aborted\x1b[0m · meta")).toBe("⊘ aborted · meta");
    expect(stripAnsi("  ↳ 13.4s elapsed · 3 tool calls")).toBe("  ↳ 13.4s elapsed · 3 tool calls");
  });
});

describe("detectStreamingPartial (the Esc trigger)", () => {
  test("2-line partial header → true (the run is mid-flight)", () => {
    const pane = [
      " Task: Write a detailed 900-word essay about fjords… ▸ tier:small ▸ spawn_subagent",
      "↳ Writing the introduction and first section of the essay…",
      "  ↳ 26.4s elapsed · 3 tool calls",
    ];
    expect(detectStreamingPartial(pane)).toBe(true);
  });

  test("settled row and idle pane → false", () => {
    expect(detectStreamingPartial(["⊘ aborted  ↳ Subagent aborted by user. · 26,613 tokens · 50s · glm-4.7"])).toBe(
      false,
    );
    expect(detectStreamingPartial(["composer", ""])).toBe(false);
  });
});

describe("detectSettledRow (the settle discriminator)", () => {
  test("settled ABORTED row detected (#2067 after-receipt)", () => {
    const pane = [
      " Task: Write a detailed 900-word essay… ▸ tier:small ▸ spawn_subagent",
      "",
      "⊘ aborted  ↳ Subagent aborted by user. · 26,613 tokens · 50s · glm-4.7",
    ];
    const row = detectSettledRow(pane);
    expect(row?.status).toBe("aborted");
    expect(row?.lineIndex).toBe(2);
  });

  test("settled TIMEDOUT row detected, not confused with partial (#2067 before-receipt)", () => {
    const pane = ["⏱ timedout  ↳ Subagent timed out. · 3s · glm-4.7"];
    expect(detectSettledRow(pane)?.status).toBe("timedout");
  });

  test("streaming partial is NOT a settle — no badge at line start", () => {
    const pane = ["↳ Writing the introduction and first section of the essay…", "  ↳ 26.4s elapsed · 3 tool calls"];
    expect(detectSettledRow(pane)).toBeNull();
  });

  test("all badge statuses discriminate", () => {
    const rows: Array<[string, string]> = [
      ["✓ done  ↳ Essay complete. · 3,412 tokens · 1m 02s · glm-4.7", "done"],
      ["⏱ timedout  ↳ Subagent timed out.", "timedout"],
      ["⛔ budget  ↳ Budget exhausted.", "budget"],
      ["⏹ turns  ↳ Turn budget exhausted.", "turns"],
      ["⊘ aborted  ↳ Subagent aborted by user.", "aborted"],
      ["✗ failed  ↳ Child process error.", "failed"],
    ];
    for (const [line, status] of rows) {
      expect(detectSettledRow([line])?.status).toBe(status);
    }
  });

  test("`→ background` badge vs an in-flight trace `→` line", () => {
    // The badge: arrow + the word, then meta/EOL.
    expect(detectSettledRow(["→ background  ↳ handed to detached subprocess"])?.status).toBe("background");
    // A trace in-flight line ALSO starts with `→` (formatHistoryLine) — the
    // trailing anchor must reject it as a settle.
    expect(detectSettledRow(["→ Read src/parser.ts … 12.3s · 4 calls"])).toBeNull();
    expect(detectSettledRow(["⌛ running  ↳ live, parent turn moved on"])?.status).toBe("running");
  });

  test("themed (ANSI-wrapped) settled row still detects; newest row wins bottom-up", () => {
    const pane = [
      "\x1b[33m⏱ timedout\x1b[0m  ↳ an older run's row",
      "",
      "\x1b[2m⊘ aborted\x1b[0m  ↳ Subagent aborted by user. · 26,613 tokens · 50s · glm-4.7",
    ];
    const row = detectSettledRow(pane);
    expect(row?.status).toBe("aborted");
    expect(row?.lineIndex).toBe(2);
    expect(row?.line.startsWith("⊘ aborted")).toBe(true); // receipt copy is ANSI-free
  });

  test("empty pane → null, never throws", () => {
    expect(detectSettledRow([])).toBeNull();
  });
});

describe("drift guard: badge table ↔ settledHeaderRow ladder (reviewer nit 2)", () => {
  // The table's sync with subagent-tool-render.ts is otherwise only a comment
  // convention — a renamed badge (e.g. `⊘ aborted` → `⊘ cancelled`) would pass
  // every unit test and only late-fail inside a lane run. Reading the RENDER
  // source and asserting each badge appears there pins the coupling offline.
  test("every BADGE_BY_STATUS value is rendered by settledHeaderRow", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(import.meta.dir, "..", "src", "subagent-tool-render.ts"), "utf8");
    for (const badge of Object.values(BADGE_BY_STATUS)) {
      expect(source.includes(`"${badge}"`), `settledHeaderRow no longer renders "${badge}"`).toBe(true);
    }
  });
});
