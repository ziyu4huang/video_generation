import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveModelTierConfig } from "@repo/pi-agent-ext-subagent/src/model-role-config.ts";
import { resolveVisionLLM } from "../src/sessions.ts";

test("resolveVisionLLM reads capabilities.vision", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-vis-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lm-studio/qwen-vl:medium" } });
  try {
    const llm = resolveVisionLLM();
    expect(llm.provider).toBe("lm-studio");
    expect(llm.modelId).toBe("qwen-vl");
    expect(llm.thinkingLevel).toBe("medium");
  } finally {
    process.env.HOME = homeBackup;
  }
});

test("resolveVisionLLM: explicit model wins over capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-vis-"));
  const homeBackup = process.env.HOME;
  process.env.HOME = dir;
  saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lm-studio/qwen-vl" } });
  try {
    const llm = resolveVisionLLM({ model: "openai/explicit" });
    expect(llm.provider).toBe("openai");
    expect(llm.modelId).toBe("explicit");
  } finally {
    process.env.HOME = homeBackup;
  }
});

test("resolveVisionLLM throws when unconfigured (ticket 01)", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-throw-"));
  const homeBackup = process.env.HOME;
  const modelBackup = process.env.PI_MODEL;
  process.env.HOME = dir;
  delete process.env.PI_MODEL;
  try {
    expect(() => resolveVisionLLM()).toThrow(/No model configured/);
  } finally {
    process.env.HOME = homeBackup;
    if (modelBackup !== undefined) process.env.PI_MODEL = modelBackup;
  }
});

test("resolveVisionLLM: PI_MODEL env is the deprecated escape hatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "f2m-env-"));
  const homeBackup = process.env.HOME;
  const modelBackup = process.env.PI_MODEL;
  process.env.HOME = dir;
  process.env.PI_MODEL = "zai/glm-5.2";
  try {
    const llm = resolveVisionLLM();
    expect(llm.provider).toBe("zai");
    expect(llm.modelId).toBe("glm-5.2");
  } finally {
    process.env.HOME = homeBackup;
    if (modelBackup === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = modelBackup;
  }
});
