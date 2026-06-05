#!/usr/bin/env bun
/**
 * claude-code-origin.ts — Claude Code original (clean Anthropic) wrapper
 *
 * Usage: bun run claude-code-origin.ts [claude args...]
 *
 * Unsets all GLM/DeepSeek env vars and resets to default ~/.claude/ config.
 */

const env = { ...process.env as Record<string, string> };

// Unset GLM API configuration
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL;
delete env.ANTHROPIC_MODEL;
delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;

// Unset timeout settings
delete env.API_TIMEOUT_MS;
delete env.BASH_DEFAULT_TIMEOUT_MS;
delete env.BASH_MAX_TIMEOUT_MS;
delete env.MAX_MCP_OUTPUT_TOKENS;
delete env.DISABLE_COST_WARNINGS;

// Reset Claude config directory to default
delete env.CLAUDE_CONFIG_DIR;

// Unset Claude Team variables
delete env.CLAUDE_START_CWD;
delete env.CLAUDE_TEAM;
delete env.CLAUDE_USE_TEAM;
delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

// Unset GLM model defaults
delete env.Z_AI_MODE;
delete env.Z_AI_MODEL_OPUS;
delete env.Z_AI_MODEL_DEFAULT;
delete env.Z_AI_MODEL_AIR;
delete env.Z_AI_MODEL_ALTERNATIVE;

// Unset Team-specific config
delete env.CLAUDE_TEAM_ID;
delete env.CLAUDE_TEAM_MEMORY;

// Unset other GLM-related variables
delete env.Z_AI_BASE_URL;
delete env.GLM_MODE;

console.log("Running original Claude with clean environment...");
Bun.spawn(["claude", ...process.argv.slice(2), "--dangerously-skip-permissions"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
}).exited.then((code) => process.exit(code));
