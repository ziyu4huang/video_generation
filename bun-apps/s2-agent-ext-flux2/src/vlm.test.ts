import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVlmLLM } from "./vlm.ts";

/** Point HOME at a temp dir seeded with a model-tiers.json. */
function withTempTierConfig(config: unknown, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "flux2-vlm-"));
  const homeBackup = process.env.HOME;
  const modelBackup = process.env.PI_MODEL;
  process.env.HOME = dir;
  delete process.env.PI_MODEL;
  mkdirSync(join(dir, ".pi/workflows"), { recursive: true });
  writeFileSync(join(dir, ".pi/workflows/model-tiers.json"), JSON.stringify(config));
  try {
    fn();
  } finally {
    process.env.HOME = homeBackup;
    if (modelBackup !== undefined) process.env.PI_MODEL = modelBackup;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveVlmLLM resolves the central capabilities.vision slot", () => {
  withTempTierConfig(
    {
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    },
    () => {
      const llm = resolveVlmLLM();
      expect(llm.provider).toBe("lm-studio");
      expect(llm.modelId).toBe("google/gemma-4-12b");
    },
  );
});

test("resolveVlmLLM: explicit override wins over the central slot", () => {
  withTempTierConfig(
    {
      tiers: { small: "zai/glm-4.7" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    },
    () => {
      const llm = resolveVlmLLM("openai/gpt-4.1-mini");
      expect(llm.provider).toBe("openai");
      expect(llm.modelId).toBe("gpt-4.1-mini");
    },
  );
});
