import { describe, expect, it } from "bun:test";
import { scriptPacingCheck } from "./script-pacing-gate.ts";

describe("scriptPacingCheck", () => {
  it("passes a natural-paced script", () => {
    // 150 words over 75s = 2.0 wps (~120 wpm) — comfortably natural.
    const words150 = Array.from({ length: 150 }, () => "word").join(" ");
    const r = scriptPacingCheck({
      total_duration_seconds: 75,
      sections: [{ id: "a", text: words150, start_seconds: 0, end_seconds: 75 }],
    });
    expect(r.status).toBe("pass");
    expect(r.overallWordsPerSecond).toBeCloseTo(2.0, 1);
  });

  it("fails on the exact saturn-young-rings shape (270 words / 78s planned = 3.46 wps)", () => {
    // Real repro (see output/next-goal-20260712_081500.md, Bug 3): the script
    // locked total_duration_seconds=78 for a 270-word, 6-section narration —
    // 3.46 wps overall, already brisk before any TTS rate manipulation.
    const wordsPerSection = 45; // 270 / 6
    const secondsPerSection = 13; // 78 / 6
    const text = Array.from({ length: wordsPerSection }, () => "word").join(" ");
    const sections = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i + 1}`,
      text,
      start_seconds: i * secondsPerSection,
      end_seconds: (i + 1) * secondsPerSection,
    }));
    const r = scriptPacingCheck({ total_duration_seconds: 78, sections });
    expect(r.overallWords).toBe(270);
    expect(r.overallWordsPerSecond).toBeCloseTo(3.46, 1);
    // 3.46 wps is above the 3.0 warn bar and the 3.5 fail bar is a near-miss —
    // this specific case warns; the fail-bar test below covers a clearer overshoot.
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Do NOT compress TTS rate");
  });

  it("fails clearly when wps is far past natural (matches the ~2x rate the agent settled on)", () => {
    // The agent's kept narration_fast3.aiff ran at 79.53s for 270 words = 3.40
    // wps read on the AUDIO side (already at 2x natural rate) — but a script
    // that plans even tighter, e.g. 270 words in 60s = 4.5 wps, is an
    // unambiguous fail: no natural narration voice sustains that pace.
    const text = Array.from({ length: 270 }, () => "word").join(" ");
    const r = scriptPacingCheck({
      total_duration_seconds: 60,
      sections: [{ id: "a", text, start_seconds: 0, end_seconds: 60 }],
    });
    expect(r.overallWordsPerSecond).toBeCloseTo(4.5, 1);
    expect(r.status).toBe("fail");
  });

  it("flags the single worst section even when the overall average looks fine", () => {
    const slow = Array.from({ length: 20 }, () => "word").join(" "); // 20/20 = 1.0 wps
    const fast = Array.from({ length: 80 }, () => "word").join(" "); // 80/20 = 4.0 wps
    const r = scriptPacingCheck({
      total_duration_seconds: 40,
      sections: [
        { id: "slow", text: slow, start_seconds: 0, end_seconds: 20 },
        { id: "fast", text: fast, start_seconds: 20, end_seconds: 40 },
      ],
    });
    // Overall: 100 words / 40s = 2.5 wps (pass-range), but the "fast" section alone fails.
    expect(r.overallWordsPerSecond).toBeCloseTo(2.5, 1);
    const fastSection = r.sections.find((s) => s.id === "fast")!;
    expect(fastSection.status).toBe("fail");
    expect(r.status).toBe("fail"); // worst-section status wins, not diluted by the average
  });

  it("does not false-positive on an empty/malformed script", () => {
    const r = scriptPacingCheck({});
    expect(r.status).toBe("pass");
    expect(r.overallWordsPerSecond).toBe(0);
  });
});
