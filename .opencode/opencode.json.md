# opencode.json — MCP & Agent Config

## MCP Servers

All 4 MCP servers mirror Claude GLM's `~/.claude-glm/.claude.json` MCP config.

| Server | Type | Env Var | Source (Claude GLM) |
|--------|------|---------|-------------------|
| `web-search-prime` | remote | `ZAI_API_KEY` | `.claude.json` line 916 |
| `web-reader` | remote | `ZAI_API_KEY` | `.claude.json` line 923 |
| `zread` | remote | `ZAI_API_KEY` | `.claude.json` line 930 |
| `zai-mcp-server` | local | `ZAI_API_KEY` | `.claude.json` line 937 |

OpenCode uses `{env:VAR}` syntax (vs Claude's `${VAR}`), `"type": "remote"/"local"` (vs Claude's `"http"/"stdio"`), and `"command"` as array (vs Claude's separate `command` + `args`).

## Agents

| Agent | Model | Purpose |
|-------|-------|---------|
| `build` (default) | `lmstudio/google/gemma-4-26b-a4b-qat` | LMStudio local build |
| `plan` | `lmstudio/google/gemma-4-26b-a4b-qat` | Planning, read-only |
| `explore` | `lmstudio/google/gemma-4-26b-a4b-qat` | Codebase search |
| `build-my-ds-pro` | `my-ds/deepseek-v4-pro` | DeepSeek V4 Pro coding |
| `build-my-ds-flash` | `my-ds/deepseek-v4-flash` | DeepSeek V4 Flash coding |
| `build-my-zai` | `my-zai/glm-5.1` | GLM coding |
| `plan-my-zai` | `my-zai/glm-4.7` | GLM planning |
| `explore-my-zai` | `my-zai/glm-4.5-air` | GLM fast explore |
| `explore-my-ds` | `my-ds/deepseek-v4-flash` | DeepSeek exploration |
| `Build_Qwen35VL` | `lmstudio/qwen/qwen3.6-35b-a3b` | Qwen local build |
| `Build_Qwen27b` | `omlx/Qwen3.6-27B-MTPLX-Optimized-Speed` | Qwen 27B local build |
| `vlm-review` | `lmstudio/google/gemma-4-26b-a4b-qat` | Image quality review |
| `plan-my-ds-pro` | `my-ds/deepseek-v4-pro` | DS Pro planning |
| `plan-my-ds-flash` | `my-ds/deepseek-v4-flash` | DS Flash planning |

## Providers

| Provider | Base URL | Models |
|----------|----------|--------|
| `my-zai` | `api.z.ai/api/coding/paas/v4` | GLM-5.1, GLM-4.7, GLM-4.5-Air, GLM-5V-Turbo |
| `my-ds` | `api.deepseek.com` | DeepSeek-V4-Pro, DeepSeek-V4-Flash |
| `ds4` | `127.0.0.1:8000/v1` | DeepSeek V4 Flash (local ds4.c) |
| `lmstudio` | `127.0.0.1:1234/v1` | Qwen3.6-35B-A3B, Gemma-4-26B-A4B-QAT |
| `omlx` | `127.0.0.1:8888/v1` | Gemma-4-26B-Vision, Qwen3.6-27B-Speed |

## Secrets (Env Vars)

- `ZAI_API_KEY` — Z.AI API key (providers + MCP auth)
- `DEEPSEEK_API_KEY` — DeepSeek API key
