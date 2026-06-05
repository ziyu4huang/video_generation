#!/usr/bin/env bash
########################################
# Claude Code — Custom Profile Wrapper
#
# Runs Claude Code with an isolated config directory (~/.claude-custom),
# completely separate from the default ~/.claude profile.
#
# USAGE:
#   source scripts/claude-code-custom.sh
#   claude-code-custom [claude args...]
#
# Or run directly:
#   bash scripts/claude-code-custom.sh [claude args...]
#
# FIRST RUN:
#   Automatically clones ~/.claude into ~/.claude-custom so you get
#   all existing settings, skills, plugins, and project configs.
#   After that, the two profiles evolve independently.
########################################

readonly CUSTOM_CONFIG_DIR="${HOME}/.claude-custom"
readonly SOURCE_CONFIG_DIR="${HOME}/.claude"

_ensure_custom_config() {
  if [ ! -d "${CUSTOM_CONFIG_DIR}" ]; then
    echo "Initializing custom config at ${CUSTOM_CONFIG_DIR} ..."
    cp -a "${SOURCE_CONFIG_DIR}" "${CUSTOM_CONFIG_DIR}"
    echo "Done. Custom profile ready."
  fi
}

claude-code-custom()
{
  _ensure_custom_config

  # Run in subshell to avoid side effects
  (
    # --- Unset GLM API configuration ---
    unset ANTHROPIC_AUTH_TOKEN
    unset ANTHROPIC_BASE_URL
    unset ANTHROPIC_MODEL
    unset ANTHROPIC_DEFAULT_HAIKU_MODEL
    unset ANTHROPIC_DEFAULT_SONNET_MODEL
    unset ANTHROPIC_DEFAULT_OPUS_MODEL

    # --- Unset timeout settings ---
    unset API_TIMEOUT_MS
    unset BASH_DEFAULT_TIMEOUT_MS
    unset BASH_MAX_TIMEOUT_MS
    unset MAX_MCP_OUTPUT_TOKENS
    unset DISABLE_COST_WARNINGS

    # --- Unset Claude Team variables ---
    unset CLAUDE_START_CWD
    unset CLAUDE_TEAM
    unset CLAUDE_USE_TEAM
    unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    unset CLAUDE_TEAM_ID
    unset CLAUDE_TEAM_MEMORY

    # --- Unset GLM model defaults ---
    unset Z_AI_MODE
    unset Z_AI_MODEL_OPUS
    unset Z_AI_MODEL_DEFAULT
    unset Z_AI_MODEL_AIR
    unset Z_AI_MODEL_ALTERNATIVE
    unset Z_AI_BASE_URL
    unset GLM_MODE

    # --- Set custom config directory ---
    export CLAUDE_CONFIG_DIR="${CUSTOM_CONFIG_DIR}"
    export CLAUDE_START_CWD="${PWD}"

    exec claude "$@" --dangerously-skip-permissions
  )
}

# Auto-run when executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    claude-code-custom "$@"
fi
