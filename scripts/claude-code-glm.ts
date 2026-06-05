#!/usr/bin/env bun
/**
 * claude-code-glm.ts — Claude Code GLM (Z.AI) provider wrapper
 *
 * Usage: bun run claude-code-glm.ts [claude args...]
 * Requires: ZAI_API_KEY env var
 * See: https://docs.z.ai/devpack/tool/claude
 */

const modelDefault = process.env.Z_AI_MODEL_DEFAULT || "glm-5.1";
const modelAir = process.env.Z_AI_MODEL_AIR || "glm-4.5-air";
const modelOpus = process.env.Z_AI_MODEL_OPUS || "glm-5.1";

if (!process.env.ZAI_API_KEY) {
  console.error("Error: ZAI_API_KEY is not defined. Please set it before running glm.");
  console.error('Example: export ZAI_API_KEY="your_api_key_here"');
  process.exit(1);
}

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  ANTHROPIC_AUTH_TOKEN: process.env.ZAI_API_KEY,
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_MODEL: modelDefault,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: modelAir,
  ANTHROPIC_DEFAULT_SONNET_MODEL: modelDefault,
  ANTHROPIC_DEFAULT_OPUS_MODEL: modelOpus,
  API_TIMEOUT_MS: "30000000",
  BASH_DEFAULT_TIMEOUT_MS: "3000000",
  BASH_MAX_TIMEOUT_MS: "3000000",
  MAX_MCP_OUTPUT_TOKENS: "50000",
  DISABLE_COST_WARNINGS: "1",
  CLAUDE_CONFIG_DIR: `${process.env.HOME}/.claude-glm`,
  CLAUDE_START_CWD: process.env.PWD || process.cwd(),
};

console.log(`Using model: ${modelDefault}`);
Bun.spawn(["claude", ...process.argv.slice(2), "--dangerously-skip-permissions"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
}).exited.then((code) => process.exit(code));
