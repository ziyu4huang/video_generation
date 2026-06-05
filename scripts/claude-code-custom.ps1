<#
.SYNOPSIS
    Claude Code — Custom Profile Wrapper (PowerShell)

.DESCRIPTION
    Runs Claude Code with an isolated config directory (~/.claude-custom),
    completely separate from the default ~/.claude profile.

    On first run, automatically clones ~/.claude into ~/.claude-custom so you
    get all existing settings, skills, plugins, and project configs.
    After that, the two profiles evolve independently.

    Environment changes are isolated — original values are restored after the call.

.EXAMPLE
    . .\claude-code-custom.ps1
    claude-code-custom

.EXAMPLE
    .\claude-code-custom.ps1 --help

.NOTES
    - First run clones ~/.claude → ~/.claude-custom
    - Saves and restores all modified env vars (no permanent side effects)
    - Equivalent to claude-code-custom.sh
#>

$CUSTOM_CONFIG_DIR = Join-Path $env:USERPROFILE '.claude-custom'
$SOURCE_CONFIG_DIR = Join-Path $env:USERPROFILE '.claude'

function _ensure_custom_config {
    if (-not (Test-Path $CUSTOM_CONFIG_DIR)) {
        Write-Host "Initializing custom config at $CUSTOM_CONFIG_DIR ..."
        Copy-Item -Path $SOURCE_CONFIG_DIR -Destination $CUSTOM_CONFIG_DIR -Recurse -Force
        Write-Host "Done. Custom profile ready."
    }
}

function claude-code-custom {
    param()

    _ensure_custom_config

    # Variables to unset for clean Claude environment
    $varsToUnset = @(
        # GLM API configuration
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        # Timeout settings
        'API_TIMEOUT_MS',
        'BASH_DEFAULT_TIMEOUT_MS',
        'BASH_MAX_TIMEOUT_MS',
        'MAX_MCP_OUTPUT_TOKENS',
        'DISABLE_COST_WARNINGS',
        # Claude config
        'CLAUDE_CONFIG_DIR',
        # Claude Team variables
        'CLAUDE_START_CWD',
        'CLAUDE_TEAM',
        'CLAUDE_USE_TEAM',
        'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
        # GLM API key
        'ZAI_API_KEY',
        # GLM model defaults
        'Z_AI_MODE',
        'Z_AI_MODEL_OPUS',
        'Z_AI_MODEL_DEFAULT',
        'Z_AI_MODEL_AIR',
        'Z_AI_MODEL_ALTERNATIVE',
        # Team-specific config
        'CLAUDE_TEAM_ID',
        'CLAUDE_TEAM_MEMORY',
        # Other GLM-related variables
        'Z_AI_BASE_URL',
        'GLM_MODE'
    )

    # Save current values and unset
    $saved = @{}
    foreach ($var in $varsToUnset) {
        $saved[$var] = [System.Environment]::GetEnvironmentVariable($var, 'Process')
        [System.Environment]::SetEnvironmentVariable($var, $null, 'Process')
    }

    # Save and set CLAUDE_CONFIG_DIR to custom profile
    $savedConfigDir = [System.Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Process')
    [System.Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $CUSTOM_CONFIG_DIR, 'Process')

    try {
        Write-Host "Running Claude Code with custom profile..."
        Write-Host "  Config dir: $CUSTOM_CONFIG_DIR"
        & claude @args --dangerously-skip-permissions
    }
    finally {
        # Restore original values
        foreach ($var in $saved.Keys) {
            [System.Environment]::SetEnvironmentVariable($var, $saved[$var], 'Process')
        }
        # Restore CLAUDE_CONFIG_DIR (may have been null if unset)
        [System.Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $savedConfigDir, 'Process')
    }
}

# Auto-run when executed directly (not dot-sourced)
if ($MyInvocation.InvocationName -ne '.') {
    claude-code-custom @args
}
