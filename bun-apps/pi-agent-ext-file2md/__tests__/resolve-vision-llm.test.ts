import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveModelTierConfig } from "@repo/pi-agent-ext-subagent/src/model-role-config.ts";
import { expect, test } from "bun:test";
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
