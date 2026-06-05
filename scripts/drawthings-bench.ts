/**
 * DrawThings config schema validator + benchmark CLI.
 *
 * Usage:
 *   bun run scripts/drawthings-bench.ts benchmark
 *   bun run scripts/drawthings-bench.ts benchmark --preset t1-t2i-lora
 *   bun run scripts/drawthings-bench.ts benchmark --dry-run
 */

export interface DTLoRA {
  file: string;
  weight: number;
  mode?: "base" | "refiner";
}

export interface DTConfig {
  model: string;
  refinerModel?: string;
  width: number;
  height: number;
  steps: number;
  sampler: number;
  seedMode: number;
  seed?: number;
  numFrames?: number;
  guidanceScale?: number;
  shift?: number;
  loras?: DTLoRA[];
  teaCache?: boolean;
  teaCacheThreshold?: number;
  teaCacheStart?: number;
  teaCacheEnd?: number;
  teaCacheMaxSkipSteps?: number;
  cfgZeroStar?: boolean;
  cfgZeroInitSteps?: number;
  hiresFix?: boolean;
  tiledDiffusion?: boolean;
  tiledDecoding?: boolean;
  batchSize?: number;
  batchCount?: number;
  clipSkip?: number;
  causalInferencePad?: number;
  maskBlur?: number;
  maskBlurOutset?: number;
  preserveOriginalAfterInpaint?: boolean;
  strength?: number;
  refinerStart?: number;
  sharpness?: number;
  controls?: unknown[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDTConfig(json: unknown): ValidationResult {
  const errors: string[] = [];

  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { valid: false, errors: ["config must be a non-null object"] };
  }

  const cfg = json as Record<string, unknown>;

  // Required string fields
  if (!("model" in cfg)) {
    errors.push("model is required");
  } else if (typeof cfg.model !== "string") {
    errors.push("model must be string");
  }

  // Required numeric fields
  const requiredNumbers: Array<[string, number, number]> = [
    ["width", 1, Infinity],
    ["height", 1, Infinity],
    ["steps", 1, Infinity],
    ["sampler", 0, Infinity],
    ["seedMode", 0, Infinity],
  ];

  for (const [field, min] of requiredNumbers) {
    if (!(field in cfg)) {
      errors.push(`${field} is required`);
    } else if (typeof cfg[field] !== "number") {
      errors.push(`${field} must be number`);
    } else if ((cfg[field] as number) < min) {
      errors.push(`${field} must be >= ${min}`);
    }
  }

  // Optional numeric fields with range checks
  const optionalRanges: Array<[string, number]> = [
    ["guidanceScale", 0],
    ["shift", 0],
    ["numFrames", 1],
  ];

  for (const [field, min] of optionalRanges) {
    if (field in cfg) {
      if (typeof cfg[field] !== "number") {
        errors.push(`${field} must be number`);
      } else if ((cfg[field] as number) < min) {
        errors.push(`${field} must be >= ${min}`);
      }
    }
  }

  // Optional string fields
  const optionalStrings = ["refinerModel"];
  for (const field of optionalStrings) {
    if (field in cfg && typeof cfg[field] !== "string") {
      errors.push(`${field} must be string`);
    }
  }

  // Optional boolean fields
  const optionalBooleans = [
    "teaCache",
    "cfgZeroStar",
    "hiresFix",
    "tiledDiffusion",
    "tiledDecoding",
    "preserveOriginalAfterInpaint",
  ];
  for (const field of optionalBooleans) {
    if (field in cfg && typeof cfg[field] !== "boolean") {
      errors.push(`${field} must be boolean`);
    }
  }

  // LoRA validation
  if ("loras" in cfg) {
    if (!Array.isArray(cfg.loras)) {
      errors.push("loras must be an array");
    } else {
      for (let i = 0; i < (cfg.loras as unknown[]).length; i++) {
        const lora = (cfg.loras as unknown[])[i] as Record<string, unknown>;
        if (typeof lora !== "object" || lora === null) {
          errors.push(`loras[${i}] must be an object`);
          continue;
        }
        if (!("file" in lora)) {
          errors.push(`loras[${i}].file is required`);
        } else if (typeof lora.file !== "string") {
          errors.push(`loras[${i}].file must be string`);
        }
        if (!("weight" in lora)) {
          errors.push(`loras[${i}].weight is required`);
        } else if (typeof lora.weight !== "number") {
          errors.push(`loras[${i}].weight must be number`);
        }
        if ("mode" in lora && lora.mode !== undefined) {
          if (lora.mode !== "base" && lora.mode !== "refiner") {
            errors.push(`loras[${i}].mode must be "base" or "refiner"`);
          }
        }
      }
    }
  }

  // TeaCache conditional validation
  if (cfg.teaCache === true) {
    if (!("teaCacheThreshold" in cfg)) {
      errors.push("teaCacheThreshold is required when teaCache is true");
    } else if (typeof cfg.teaCacheThreshold !== "number") {
      errors.push("teaCacheThreshold must be number");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === "benchmark") {
    await runBenchmark(args.slice(1));
  } else {
    console.log("Usage: bun run scripts/drawthings-bench.ts benchmark [--preset <name>] [--dry-run]");
    process.exit(1);
  }
}

async function runBenchmark(args: string[]) {
  const presetFlag = args.indexOf("--preset");
  const targetPreset = presetFlag !== -1 ? args[presetFlag + 1] : null;
  const dryRun = args.includes("--dry-run");

  const fixtureDir = new URL("./fixtures/drawthings/", import.meta.url).pathname;

  let fixtures: string[] = [];
  try {
    const glob = new Bun.Glob("*.json");
    for await (const file of glob.scan({ cwd: fixtureDir })) {
      fixtures.push(file);
    }
    fixtures.sort();
  } catch {
    console.error(`Fixture directory not found: ${fixtureDir}`);
    process.exit(1);
  }

  if (targetPreset) {
    fixtures = fixtures.filter((f) => f.replace(".json", "") === targetPreset);
    if (fixtures.length === 0) {
      console.error(`Preset not found: ${targetPreset}`);
      process.exit(1);
    }
  }

  const rows: Array<{ preset: string; valid: boolean; errors: string[] }> = [];

  for (const file of fixtures) {
    const preset = file.replace(".json", "");
    const content = await Bun.file(`${fixtureDir}/${file}`).json();
    const result = validateDTConfig(content);
    rows.push({ preset, ...result });
    const icon = result.valid ? "✅ PASS" : "❌ FAIL";
    const errStr = result.errors.length > 0 ? ` — ${result.errors.join("; ")}` : "";
    console.log(`${icon}  ${preset}${errStr}`);
  }

  const allPassed = rows.every((r) => r.valid);
  const date = new Date().toISOString().split("T")[0];
  const tableRows = rows
    .map((r) => `| ${r.preset} | ${r.valid ? "✅ PASS" : "❌ FAIL"} | ${r.errors.join("; ") || "—"} |`)
    .join("\n");

  const markdown = `# DrawThings Bench Results — ${date}

| Preset | Valid | Errors |
|--------|-------|--------|
${tableRows}

Run: \`bun run scripts/drawthings-bench.ts benchmark\`
`;

  if (!dryRun) {
    const outPath = new URL("../docs/drawthings/bench-results.md", import.meta.url).pathname;
    await Bun.write(outPath, markdown);
    console.log(`\nResults written to docs/drawthings/bench-results.md`);
  }

  process.exit(allPassed ? 0 : 1);
}
