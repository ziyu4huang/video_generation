#!/usr/bin/env bun
/**
 * claude-code-deepseek.ts — Claude Code DeepSeek provider wrapper
 *
 * Usage: bun run claude-code-deepseek.ts [claude args...]
 * Requires: DEEPSEEK_API_KEY env var
 * See: https://api-docs.deepseek.com/guides/anthropic_api
 */

const modelDefault = process.env.DEEPSEEK_MODEL_DEFAULT || "deepseek-v4-pro[1m]";
const modelReasoner = process.env.DEEPSEEK_MODEL_REASONER || "deepseek-v4-pro[1m]";
const modelAir = process.env.DEEPSEEK_MODEL_AIR || "deepseek-v4-flash";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY is not defined. Please set it before running deepseek.");
  console.error('Example: export DEEPSEEK_API_KEY="your_api_key_here"');
  process.exit(1);
}

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_API_KEY,
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  ANTHROPIC_MODEL: modelDefault,
  ANTHROPIC_DEFAULT_OPUS_MODEL: modelReasoner,
  ANTHROPIC_DEFAULT_SONNET_MODEL: modelDefault,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: modelAir,
  CLAUDE_CODE_SUBAGENT_MODEL: modelAir,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  CLAUDE_CODE_EFFORT_LEVEL: "max",
  API_TIMEOUT_MS: "600000",
  BASH_DEFAULT_TIMEOUT_MS: "600000",
  BASH_MAX_TIMEOUT_MS: "600000",
  MAX_MCP_OUTPUT_TOKENS: "50000",
  DISABLE_COST_WARNINGS: "1",
  CLAUDE_CONFIG_DIR: `${process.env.HOME}/.claude-deepseek`,
  CLAUDE_START_CWD: process.env.PWD || process.cwd(),
};

console.log(`Using model: ${modelDefault}`);
Bun.spawn(["claude", ...process.argv.slice(2), "--dangerously-skip-permissions"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
}).exited.then((code) => process.exit(code));
