#!/usr/bin/env bash
########################################
# Claude Code — GLM (Z.AI) Provider Wrapper
#
# Wrapper function 'glm' that connects Claude Code to the GLM API
# via an Anthropic-compatible endpoint.
# See: https://docs.z.ai/devpack/tool/claude
#
# USAGE:
#   source scripts/claude-code-glm.sh
#   glm [claude args...]
#
# Or run directly:
#   bash scripts/claude-code-glm.sh [claude args...]
#
#   2. Set your API key:
#      export ZAI_API_KEY="your_actual_api_key_here"
#
#   3. Use the glm command:
#      glm "your prompt here"
#      glm --help  # for claude help
#
# FEATURES:
# - Runs in subshell to avoid side effects on your shell environment
# - Validates API key before execution
# - Provides clear error messages for missing configuration
# - Uses default models if not overridden
#
# CUSTOMIZATION:
# Override these environment variables if needed:
#   Z_AI_MODEL_DEFAULT="glm-5.2[1m]"   # Sonnet-tier model (also the main ANTHROPIC_MODEL)
#   Z_AI_MODEL_OPUS="glm-5.2[1m]"      # Opus-tier model
#   Z_AI_MODEL_AIR="glm-4.5-air"       # Haiku-tier model (fast/cheap)
#   Z_AI_MODE="ZAI"                    # API mode
########################################

# Default values (only set if not already defined)
# The [1m] suffix on a GLM model id routes to its 1M-token context-window variant.
: "${Z_AI_MODE:="ZAI"}"
: "${Z_AI_MODEL_OPUS:="glm-5.2[1m]"}"
: "${Z_AI_MODEL_DEFAULT:="glm-5.2[1m]"}"
: "${Z_AI_MODEL_AIR:="glm-4.5-air"}"
: "${Z_AI_MODEL_ALTERNATIVE:="glm-5.2[1m]"}"

glm()
{
  # Check if ZAI_API_KEY is defined
  if [ -z "${ZAI_API_KEY:-}" ]; then
    echo "Error: ZAI_API_KEY is not defined. Please set it before running glm." >&2
    echo "Example: export ZAI_API_KEY=\"your_api_key_here\"" >&2
    return 1
  fi

  # Run in subshell to avoid side effects
  (
    # Set environment variables for this command only
    # export ANTHROPIC_AUTH_TOKEN="${ZAI_API_KEY}"
    export ANTHROPIC_AUTH_TOKEN="${ZAI_API_KEY}"
    export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
    export ANTHROPIC_MODEL="${Z_AI_MODEL_DEFAULT}"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="${Z_AI_MODEL_AIR}"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="${Z_AI_MODEL_DEFAULT}"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="${Z_AI_MODEL_OPUS}"
    # Auto-compact near the 1M context window (matches glm-5.2[1m])
    export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000"
    echo "Using model: ${ANTHROPIC_MODEL}"
    export API_TIMEOUT_MS=30000000
    export BASH_DEFAULT_TIMEOUT_MS=3000000
    export BASH_MAX_TIMEOUT_MS=3000000
    export MAX_MCP_OUTPUT_TOKENS=50000
    export DISABLE_COST_WARNINGS=1
    export CLAUDE_CONFIG_DIR="${HOME}/.claude-glm"
    # --- MCP API-key resolution (read if your z.ai MCP servers ever fail to auth) ---
    # The MCP servers in $CLAUDE_CONFIG_DIR/settings.json and .claude.json
    # (web-search-prime / web-reader / zread = http; zai-mcp-server = stdio)
    # do NOT store the key. Their headers / env hold the literal placeholder
    # ${ZAI_API_KEY}, which Claude Code expands at MCP-server *spawn* time from
    # THIS process's environment.
    #
    # Chain that makes it resolve correctly:
    #   .zshrc:  export ZAI_API_KEY=<key>     (interactive shell sources it)
    #     -> glm() subshell inherits it        (we only add vars, never unset)
    #       -> `exec claude` carries it into the Claude Code process
    #         -> at MCP spawn, ${ZAI_API_KEY} is substituted with the real key
    #            and sent as `Authorization: Bearer <key>` (http servers) or
    #            passed as a child-process env var (stdio server).
    #
    # Rotating the key — change the SOURCE, not the JSON:
    #   1. Edit the export in ~/.zshrc (prefer ~/.zshenv to also cover
    #      non-interactive / daemon launches, which skip ~/.zshrc).
    #   2. Re-launch glm. Expansion is one-shot at spawn, so already-running
    #      MCP servers keep the OLD key until the `claude` process restarts.
    #   3. NEVER edit settings.json / .claude.json — they hold only the
    #      placeholder, so they need no change on key rotation. (Both files
    #      define identical mcpServers: redundant but harmless.)
    # Set the starting working directory for Claude Code
    export CLAUDE_START_CWD="${PWD}"

    # Dynamic Workflows (always on — xhigh effort + auto multi-agent orchestration)
    export CLAUDE_CODE_WORKFLOWS=1
    export DISABLE_GROWTHBOOK=1

    exec claude "$@" --dangerously-skip-permissions
    #exec claude "$@"
  )
}

# Auto-run when executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    glm "$@"
fi
