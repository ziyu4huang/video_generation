/**
 * sessions/passthrough.ts — the exported pure helpers.
 *
 * applyVaultEnv and resolveLLMFromArgs are the non-session-driving exports.
 * resolveLLMFromArgs reads ~/.pi/agent/settings.json via getAgentDir() — we
 * redirect getAgentDir to a temp dir with PI_CODING_AGENT_DIR (the package's
 * own override), so no mock.module is needed and there is no cross-file leak
 * risk. resolveLLM itself is pinned in resolve.test.ts.
 *
 *   bun test src/cli/__tests__/passthrough.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyVaultEnv,
	resolveLLMFromArgs,
} from "../sessions/passthrough.ts";

// All env these functions read at call time.
const ENV_KEYS = [
	"OB_VAULT_PATH",
	"OB_VAULT_DIR",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_THINKING",
	"PI_CODING_AGENT_DIR",
] as const;
let saved: Record<string, string | undefined>;
let agentDir: string;

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	// Redirect getAgentDir() to an empty temp dir (no settings.json by default).
	agentDir = mkdtempSync(join(tmpdir(), "pa-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(agentDir, { recursive: true, force: true });
});

function writeSettings(obj: unknown) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
}

// --- applyVaultEnv ----------------------------------------------------------

describe("applyVaultEnv", () => {
	test("sets OB_VAULT_PATH from --vault", () => {
		applyVaultEnv({ vault: "/v" } as any);
		expect(process.env.OB_VAULT_PATH).toBe("/v");
	});

	test("sets OB_VAULT_DIR from --vault-dir", () => {
		applyVaultEnv({ vaultDir: "notes" } as any);
		expect(process.env.OB_VAULT_DIR).toBe("notes");
	});

	test("leaves both unset when neither flag is present", () => {
		applyVaultEnv({} as any);
		expect(process.env.OB_VAULT_PATH).toBeUndefined();
		expect(process.env.OB_VAULT_DIR).toBeUndefined();
	});

	test("does not clear a pre-existing env value when the flag is absent", () => {
		process.env.OB_VAULT_PATH = "/preexisting";
		applyVaultEnv({ vaultDir: "notes" } as any);
		expect(process.env.OB_VAULT_PATH).toBe("/preexisting");
		expect(process.env.OB_VAULT_DIR).toBe("notes");
	});
});

// --- resolveLLMFromArgs -----------------------------------------------------

describe("resolveLLMFromArgs", () => {
	test("no settings.json → userDefaults undefined, FALLBACK applies", async () => {
		const llm = await resolveLLMFromArgs({} as any);
		expect(llm.provider).toBe("zai");
		expect(llm.modelId).toBe("glm-5.2");
		expect(llm.thinkingLevel).toBe("medium");
	});

	test("parsed flags flow straight through (provider/model/thinking)", async () => {
		const llm = await resolveLLMFromArgs({
			provider: "anthropic",
			model: "claude-x",
			thinking: "high",
		} as any);
		expect(llm.provider).toBe("anthropic");
		expect(llm.modelId).toBe("claude-x");
		expect(llm.thinkingLevel).toBe("high");
	});

	test("settings.json defaultProvider/defaultModel apply as userDefaults", async () => {
		writeSettings({ defaultProvider: "openai", defaultModel: "gpt-4o" });
		const llm = await resolveLLMFromArgs({} as any);
		expect(llm.provider).toBe("openai");
		expect(llm.modelId).toBe("gpt-4o");
	});

	test("explicit flag beats settings.json defaults", async () => {
		writeSettings({ defaultProvider: "openai", defaultModel: "gpt-4o" });
		const llm = await resolveLLMFromArgs({
			provider: "anthropic",
			model: "claude",
		} as any);
		expect(llm.provider).toBe("anthropic");
		expect(llm.modelId).toBe("claude");
	});

	test("malformed settings.json is swallowed (best-effort) → FALLBACK", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		const llm = await resolveLLMFromArgs({} as any);
		// JSON.parse throws inside the try → caught → userDefaults stays undefined.
		expect(llm.provider).toBe("zai");
	});

	test("settings.json without the two keys → userDefaults empty → FALLBACK", async () => {
		writeSettings({ someOtherKey: 1 });
		const llm = await resolveLLMFromArgs({} as any);
		expect(llm.provider).toBe("zai");
		expect(llm.modelId).toBe("glm-5.2");
	});

	test("--model shorthand still works through this layer", async () => {
		const llm = await resolveLLMFromArgs({ model: "lm-studio/qwen" } as any);
		expect(llm.provider).toBe("lm-studio");
		expect(llm.modelId).toBe("qwen");
	});
});
