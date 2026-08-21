import { describe, expect, test } from "bun:test";
import { resolveKgModel } from "../src/llm-chat.ts";
import { resolveDistillModel } from "../src/zk-task-config.ts";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";

const CFG: ModelTierConfig = {
	tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
	capabilities: { vision: "lm-studio/google/gemma-4-12b" },
};

describe("knowledge-card central model resolution", () => {
	test("resolveKgModel strips provider prefix from capabilities.vision", () => {
		delete process.env.PI_KG_LLM_MODEL;
		expect(resolveKgModel(CFG)).toBe("google/gemma-4-12b");
	});

	test("resolveKgModel env wins over tier config", () => {
		process.env.PI_KG_LLM_MODEL = "google/gemma-4-27b";
		try {
			expect(resolveKgModel(CFG)).toBe("google/gemma-4-27b");
		} finally {
			delete process.env.PI_KG_LLM_MODEL;
		}
	});

	test("resolveKgModel keeps a local terminal default when config absent (never-throw contract)", () => {
		delete process.env.PI_KG_LLM_MODEL;
		expect(resolveKgModel(null)).toBe("google/gemma-4-12b");
	});

	test("resolveDistillModel uses tiers.small from central config", () => {
		delete process.env.KC_SUBAGENT_MODEL;
		expect(resolveDistillModel(undefined, CFG)).toBe("zai/glm-4.7");
	});

	test("resolveDistillModel explicit arg wins over config", () => {
		expect(resolveDistillModel("openai/gpt-4.1-mini", CFG)).toBe("openai/gpt-4.1-mini");
	});

	test("resolveDistillModel throws actionable error with no config and no env", () => {
		delete process.env.KC_SUBAGENT_MODEL;
		expect(() => resolveDistillModel(undefined, null)).toThrow(/model-tiers|KC_SUBAGENT_MODEL/);
	});
});
