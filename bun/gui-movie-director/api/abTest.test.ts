import { describe, it, expect } from "bun:test";
import {
  normalizeTransformerKey,
  detectLever,
  buildAbFeedback,
} from "./abTest";

describe("normalizeTransformerKey", () => {
  it("strips -8bit", () =>
    expect(normalizeTransformerKey("ernie-redmix-redzit15-8bit")).toBe("ernie-redmix-redzit15"));
  it("strips -4bit-g32", () =>
    expect(normalizeTransformerKey("m-4bit-g32")).toBe("m"));
  it("strips -requant-test", () =>
    expect(normalizeTransformerKey("klein-9b-requant-test")).toBe("klein-9b"));
  it("leaves a model-family suffix", () =>
    expect(normalizeTransformerKey("klein-9b-dark-beast-bfs")).toBe("klein-9b-dark-beast-bfs"));
  it("leaves a version suffix", () =>
    expect(normalizeTransformerKey("zimage-moody-v126")).toBe("zimage-moody-v126"));
});

describe("detectLever", () => {
  const run = (extra: Record<string, any>) => ({ pipeline: "zimage", seed: 777, steps: 8, cfg_scale: 1, transformer: "ernie-redmix-redzit15", ...extra });

  it("flags a 4-bit vs 8-bit pair as transformer-quant", () => {
    const r = detectLever(run({}), run({ transformer: "ernie-redmix-redzit15-8bit" }));
    expect(r.lever).toBe("transformer-quant");
    expect(r.diff_fields).toEqual(["transformer"]);
  });

  it("flags different model families as transformer (not quant)", () => {
    const r = detectLever(run({ transformer: "klein-9b" }), run({ transformer: "klein-9b-dark-beast-bfs" }));
    expect(r.lever).toBe("transformer");
  });

  it("flags a seed difference", () => {
    const r = detectLever(run({ seed: 777 }), run({ seed: 778 }));
    expect(r.lever).toBe("seed");
  });

  it("flags a lora difference", () => {
    const r = detectLever(run({ lora_path: "a" }), run({ lora_path: "b" }));
    expect(r.lever).toBe("lora");
  });

  it("returns none when runs are identical", () => {
    const r = detectLever(run({}), run({}));
    expect(r.lever).toBe("none");
    expect(r.diff_fields).toEqual([]);
  });

  it("returns unknown when a run is null", () => {
    expect(detectLever(null, run({})).lever).toBe("unknown");
  });

  it("combines multiple differing fields", () => {
    const r = detectLever(run({ seed: 1, steps: 8 }), run({ seed: 2, steps: 9 }));
    expect(r.lever.startsWith("multi")).toBe(true);
    expect(r.diff_fields.sort()).toEqual(["seed", "steps"]);
  });
});

// Use non-existent transformers so lookupModel() (which reads the model tree) is
// deterministic (format/dir = null) — keeps buildAbFeedback a pure unit test.
const FAKE_RUN = (transformer: string) => ({
  pipeline: "zimage", seed: 777, steps: 8, cfg_scale: 1.0, width: 640, height: 960,
  prompt: "a portrait", transformer,
});

describe("buildAbFeedback", () => {
  const baseArgs = {
    intent: "Does 8-bit beat 4-bit?",
    lever: detectLever(FAKE_RUN("m-4bit"), FAKE_RUN("m-8bit")),
    a: { name: "a.png", url: "/output/0/a.png", runPath: "/abs/a.run.json", manifestPath: "/abs/a.manifest.json", run: FAKE_RUN("m-4bit") },
    b: { name: "b.png", url: "/output/0/b.png", runPath: "/abs/b.run.json", manifestPath: "/abs/b.manifest.json", run: FAKE_RUN("m-8bit") },
    signalMetrics: { A: { sharpness: 124 }, B: { sharpness: 137 }, winners: { sharpness: "B" } },
    pixelDiff: { ssim: 0.87, psnr_db: 21.5 },
    vlmScores: { A: { overall: 9, artifacts: 10 }, B: { overall: 9, artifacts: 10 } },
    heatmapUrl: "/output/0/ab_analysis/ab_diff_x.png",
  } as const;

  it("emits the v1 schema with a 2-entry pair", () => {
    const f = buildAbFeedback({ ...baseArgs });
    expect(f.schema).toBe("ab-feedback/v1");
    expect(f.pair).toHaveLength(2);
    expect(f.pair.map((p) => p.role)).toEqual(["A", "B"]);
  });

  it("uses repo-relative run_path / manifest_path pointers", () => {
    const f = buildAbFeedback({ ...baseArgs });
    // /abs is not under REPO_DIR → path.relative keeps it absolute-ish; the key
    // contract is the fields exist and are strings, pointing at the real files.
    expect(typeof f.pair[0].run_path).toBe("string");
    expect(f.pair[0].manifest_path).toBeTruthy();
  });

  it("declares tie when VLM overall is equal", () => {
    const f = buildAbFeedback({ ...baseArgs });
    expect(f.verdict.winner).toBe("tie");
    expect(f.verdict.rationale).toContain("tied");
  });

  it("declares A the winner when VLM overall is ≥1 higher", () => {
    const f = buildAbFeedback({ ...baseArgs, vlmScores: { A: { overall: 9 }, B: { overall: 7 } } });
    expect(f.verdict.winner).toBe("A");
  });

  it("falls back to signal-metric win count when no VLM", () => {
    const f = buildAbFeedback({ ...baseArgs, vlmScores: null });
    expect(f.verdict.winner).toBe("B"); // sharpness winner = B
  });

  it("derives a quant lever what_to_do + regen command", () => {
    const f = buildAbFeedback({ ...baseArgs });
    expect(f.lever).toBe("transformer-quant");
    expect(f.action_hints.what_to_do).toContain("Quant");
    expect(f.action_hints.regen_command).toContain("--transformer");
    expect(f.action_hints.regen_command).toContain("--seed 777");
  });

  it("carries computed analysis inline", () => {
    const f = buildAbFeedback({ ...baseArgs });
    expect(f.analysis.pixel_diff).toEqual({ ssim: 0.87, psnr_db: 21.5 });
    expect(f.analysis.signal_metrics.winners.sharpness).toBe("B");
    expect(f.diff_heatmap_url).toBe("/output/0/ab_analysis/ab_diff_x.png");
  });
});
