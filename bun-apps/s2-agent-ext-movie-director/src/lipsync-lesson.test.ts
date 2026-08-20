import { describe, expect, test } from "bun:test";
import { buildLipsyncLesson } from "./lipsync-lesson.ts";

describe("buildLipsyncLesson", () => {
  test("adequate verdict -> target=memory, category=insight", () => {
    const lesson = buildLipsyncLesson({
      verdict: "adequate",
      pearsonR: 0.55,
      mouthRatioStd: 0.056,
      seed: 501,
      promptSummary: "simple talking prompt",
      identityRef: "kai_source.png",
      voice: "am_michael",
    });
    expect(lesson.target).toBe("memory");
    expect(lesson.category).toBe("insight");
    expect(lesson.content).toContain("kai_source.png");
    expect(lesson.content).toContain("am_michael");
    expect(lesson.content).toContain("seed=501");
    expect(lesson.content).toContain("0.55");
    expect(lesson.reason).toBeUndefined();
  });

  test("inadequate verdict with a caveat -> target=failure, category=tool-quirk, reason=caveat", () => {
    const lesson = buildLipsyncLesson({
      verdict: "inadequate",
      pearsonR: -0.35,
      mouthRatioStd: 0.018,
      seed: 501,
      promptSummary: "simple talking prompt",
      identityRef: "kai_source.png",
      voice: "am_michael",
      caveat: "pearson_r is strongly negative — anti-phase, not genuine lip-sync.",
    });
    expect(lesson.target).toBe("failure");
    expect(lesson.category).toBe("tool-quirk");
    expect(lesson.reason).toBe("pearson_r is strongly negative — anti-phase, not genuine lip-sync.");
    expect(lesson.content).toContain("kai_source.png");
  });

  test("inadequate verdict with no caveat -> reason falls back to the verdict string", () => {
    const lesson = buildLipsyncLesson({
      verdict: "inadequate",
      pearsonR: 0.24,
      mouthRatioStd: 0.03,
      seed: 511,
      identityRef: "dov_source_v3.png",
      voice: "am_onyx",
    });
    expect(lesson.target).toBe("failure");
    expect(lesson.reason).toBe("verdict=inadequate");
  });

  test("missing optional fields (seed/promptSummary) still produce valid content", () => {
    const lesson = buildLipsyncLesson({
      verdict: "adequate",
      pearsonR: 0.5,
      mouthRatioStd: 0.04,
      identityRef: "dov_source_v3.png",
      voice: "am_onyx",
    });
    expect(lesson.content).toContain("dov_source_v3.png");
    expect(lesson.content).not.toContain("seed=undefined");
  });

  test("setup/infra-error verdict (e.g. no_face) is worded distinctly from a real measured failure", () => {
    const lesson = buildLipsyncLesson({
      verdict: "no_face",
      pearsonR: null,
      mouthRatioStd: null,
      identityRef: "dov_source_v3.png",
      voice: "am_onyx",
    });
    expect(lesson.target).toBe("failure");
    expect(lesson.category).toBe("tool-quirk");
    expect(lesson.content).toContain("inconclusive");
    expect(lesson.content).toContain("Not a quality judgment");
    expect(lesson.content).not.toContain("Lipdub combo fails");
    expect(lesson.reason).toBe("verdict=no_face");
  });

  test("setup/infra-error verdict with a caveat uses the caveat as reason", () => {
    const lesson = buildLipsyncLesson({
      verdict: "sync_venv_missing",
      pearsonR: null,
      mouthRatioStd: null,
      identityRef: "kai_source.png",
      voice: "am_michael",
      caveat: "syncnet venv not found on this machine",
    });
    expect(lesson.reason).toBe("syncnet venv not found on this machine");
    expect(lesson.content).toContain("inconclusive");
  });
});
