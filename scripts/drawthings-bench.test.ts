import { describe, test, expect, afterAll } from "bun:test";
import { validateDTConfig } from "./drawthings-bench";
import { join } from "path";

const fixtureDir = join(import.meta.dir, "fixtures/drawthings");

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function loadFixture(name: string): unknown {
  return require(`${fixtureDir}/${name}.json`);
}

// ─── Minimal valid T2I config (inline, for unit tests) ───────────────────────

const validT2I = {
  width: 768,
  height: 1152,
  guidanceScale: 1,
  clipSkip: 1,
  sharpness: 0,
  refinerStart: 0.1,
  causalInferencePad: 0,
  cfgZeroStar: false,
  batchSize: 1,
  hiresFix: false,
  loras: [{ file: "wan_2.1_14b_self_forcing_t2v_v2_lora_f16.ckpt", weight: 1 }],
  seedMode: 2,
  model: "wan_v2.2_a14b_hne_t2v_q6p_svd.ckpt",
  cfgZeroInitSteps: 0,
  sampler: 15,
  controls: [],
  maskBlurOutset: 0,
  shift: 0.66,
  tiledDiffusion: false,
  maskBlur: 1.5,
  preserveOriginalAfterInpaint: true,
  strength: 1,
  batchCount: 1,
  steps: 6,
  numFrames: 1,
  refinerModel: "wan_v2.2_a14b_lne_t2v_q6p_svd.ckpt",
  seed: 1020939176,
  teaCache: false,
  tiledDecoding: false,
};

// Track results for afterAll write
const benchResults: Array<{ preset: string; valid: boolean; errors: string[] }> = [];

// ─── Fixture preset tests (#392 core requirement) ────────────────────────────

describe("DrawThings config validation — t1 presets (from docs/drawthings/t1.md)", () => {
  test("t1-t2i-lora: self-forcing LoRA T2I (numFrames:1, steps:6)", () => {
    const cfg = loadFixture("t1-t2i-lora");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t1-t2i-lora", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("t1-t2i-raw: no-LoRA T2I (numFrames:1, steps:20, guidanceScale:3.5)", () => {
    const cfg = loadFixture("t1-t2i-raw");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t1-t2i-raw", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("t1-t2v: T2V self-forcing LoRA (numFrames:81, shift:8)", () => {
    const cfg = loadFixture("t1-t2v");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t1-t2v", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("t1-i2v: I2V self-forcing LoRA (numFrames:101, i2v model)", () => {
    const cfg = loadFixture("t1-i2v");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t1-i2v", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("DrawThings config validation — t2 presets (from docs/drawthings/t2.md)", () => {
  test("t2-t2i-lightning: TeaCache T2I (teaCache:true, high/low LoRA)", () => {
    const cfg = loadFixture("t2-t2i-lightning");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t2-t2i-lightning", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("t2-t2v-lightning: Lightning T2V (numFrames:81, mode:base/refiner LoRAs)", () => {
    const cfg = loadFixture("t2-t2v-lightning");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t2-t2v-lightning", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("t2-i2v-lightning: Lightning I2V (numFrames:81, i2v high/low LoRAs)", () => {
    const cfg = loadFixture("t2-i2v-lightning");
    const result = validateDTConfig(cfg);
    benchResults.push({ preset: "t2-i2v-lightning", ...result });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── Happy path unit tests ────────────────────────────────────────────────────

describe("DrawThings config validation — happy path", () => {
  test("valid T2I config returns valid:true with no errors", () => {
    const result = validateDTConfig(validT2I);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid T2V config (numFrames:81) returns valid:true", () => {
    const result = validateDTConfig({ ...validT2I, numFrames: 81, shift: 8 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("config with TeaCache enabled and valid threshold passes", () => {
    const result = validateDTConfig({
      ...validT2I,
      teaCache: true,
      teaCacheThreshold: 0.22,
      teaCacheStart: 3,
      teaCacheEnd: -2,
      teaCacheMaxSkipSteps: 3,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("config with LoRA mode base/refiner passes", () => {
    const result = validateDTConfig({
      ...validT2I,
      loras: [
        { mode: "base", file: "wan2.2_high_v1.1_lora_f16.ckpt", weight: 1 },
        { mode: "refiner", file: "wan2.2_low_v1.1_lora_f16.ckpt", weight: 1 },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("empty loras array is valid", () => {
    const result = validateDTConfig({ ...validT2I, loras: [] });
    expect(result.valid).toBe(true);
  });
});

// ─── Required fields ──────────────────────────────────────────────────────────

describe("DrawThings config validation — required fields", () => {
  test("missing model returns error", () => {
    const { model: _, ...noModel } = validT2I;
    const result = validateDTConfig(noModel);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("model"))).toBe(true);
  });

  test("missing width returns error", () => {
    const { width: _, ...noWidth } = validT2I;
    const result = validateDTConfig(noWidth);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("width"))).toBe(true);
  });

  test("missing height returns error", () => {
    const { height: _, ...noHeight } = validT2I;
    const result = validateDTConfig(noHeight);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("height"))).toBe(true);
  });

  test("missing steps returns error", () => {
    const { steps: _, ...noSteps } = validT2I;
    const result = validateDTConfig(noSteps);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("steps"))).toBe(true);
  });

  test("missing sampler returns error", () => {
    const { sampler: _, ...noSampler } = validT2I;
    const result = validateDTConfig(noSampler);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sampler"))).toBe(true);
  });

  test("missing seedMode returns error", () => {
    const { seedMode: _, ...noSeedMode } = validT2I;
    const result = validateDTConfig(noSeedMode);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("seedMode"))).toBe(true);
  });
});

// ─── Type errors ──────────────────────────────────────────────────────────────

describe("DrawThings config validation — type errors", () => {
  test("model must be string", () => {
    const result = validateDTConfig({ model: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("model must be string");
  });

  test("non-object input returns error", () => {
    const result = validateDTConfig("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("null input returns error", () => {
    const result = validateDTConfig(null);
    expect(result.valid).toBe(false);
  });

  test("width must be number", () => {
    const result = validateDTConfig({ ...validT2I, width: "768" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("width"))).toBe(true);
  });

  test("steps must be number", () => {
    const result = validateDTConfig({ ...validT2I, steps: "6" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("steps"))).toBe(true);
  });
});

// ─── Range errors ─────────────────────────────────────────────────────────────

describe("DrawThings config validation — range errors", () => {
  test("steps < 1 returns error", () => {
    const result = validateDTConfig({ ...validT2I, steps: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("steps must be >= 1");
  });

  test("steps = 0 returns error", () => {
    const result = validateDTConfig({ ...validT2I, steps: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("steps"))).toBe(true);
  });

  test("numFrames < 1 returns error", () => {
    const result = validateDTConfig({ ...validT2I, numFrames: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("numFrames"))).toBe(true);
  });

  test("guidanceScale < 0 returns error", () => {
    const result = validateDTConfig({ ...validT2I, guidanceScale: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("guidanceScale"))).toBe(true);
  });

  test("shift < 0 returns error", () => {
    const result = validateDTConfig({ ...validT2I, shift: -0.1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shift"))).toBe(true);
  });
});

// ─── LoRA validation ──────────────────────────────────────────────────────────

describe("DrawThings config validation — LoRA validation", () => {
  test("LoRA without file field returns error", () => {
    const result = validateDTConfig({
      ...validT2I,
      loras: [{ weight: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("loras[0]"))).toBe(true);
  });

  test("LoRA with non-string file returns error", () => {
    const result = validateDTConfig({
      ...validT2I,
      loras: [{ file: 123, weight: 1 }],
    });
    expect(result.valid).toBe(false);
  });

  test("LoRA with invalid mode returns error", () => {
    const result = validateDTConfig({
      ...validT2I,
      loras: [{ file: "test.ckpt", weight: 1, mode: "invalid" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
  });
});

// ─── TeaCache conditional ─────────────────────────────────────────────────────

describe("DrawThings config validation — TeaCache conditional", () => {
  test("teaCache:false does not require teaCacheThreshold", () => {
    const result = validateDTConfig({ ...validT2I, teaCache: false });
    expect(result.valid).toBe(true);
  });

  test("teaCache:true with missing teaCacheThreshold returns error", () => {
    const result = validateDTConfig({ ...validT2I, teaCache: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("teaCacheThreshold"))).toBe(true);
  });

  test("teaCache:true with valid threshold passes", () => {
    const result = validateDTConfig({
      ...validT2I,
      teaCache: true,
      teaCacheThreshold: 0.22,
    });
    expect(result.valid).toBe(true);
  });
});

// ─── afterAll: write bench-results.md ────────────────────────────────────────

afterAll(async () => {
  if (benchResults.length === 0) return;

  const date = new Date().toISOString().split("T")[0];
  const tableRows = benchResults
    .map((r) => `| ${r.preset} | ${r.valid ? "✅ PASS" : "❌ FAIL"} | ${r.errors.join("; ") || "—"} |`)
    .join("\n");

  const passed = benchResults.filter((r) => r.valid).length;
  const failed = benchResults.filter((r) => !r.valid).length;

  const markdown = `# DrawThings Bench Results — ${date}

| Preset | Valid | Errors |
|--------|-------|--------|
${tableRows}

**Summary:** ${passed} passed, ${failed} failed out of ${benchResults.length} presets.

Run: \`bun test scripts/drawthings-bench.test.ts\`
`;

  const outPath = join(import.meta.dir, "../docs/drawthings/bench-results.md");
  await Bun.write(outPath, markdown);
});
