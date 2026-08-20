# PRD — s2-agent-ext-zai-mcp

## Problem

Pi has no built-in MCP (Model Context Protocol) integration. Without it, agents cannot use Z.ai's MCP servers for web search, URL reading, and parsing — tools that are available to Claude Code but not to Pi agents.

## Solution

Z.ai MCP servers wrapped as a Pi package. Acts as an MCP client (using `@modelcontextprotocol/sdk`) and re-registers each tool exposed by configured Z.ai MCP servers as a normal Pi tool. Servers: `web-search-prime` (web search), `web-reader` (fetch URL), `zread` (read & parse), plus a planned stdio server `zai-mcp-server`.

## Tools

| Tool | Source MCP Server | Description |
|------|-------------------|-------------|
| MCP-based tools | `web-search-prime` | Web search via Z.ai |
| MCP-based tools | `web-reader` | Fetch/read a URL |
| MCP-based tools | `zread` | Read & parse |

## Key Dependencies

- `@modelcontextprotocol/sdk` (MCP client)
- `ZAI_API_KEY` env var
- Network access to Z.ai MCP servers (https://api.z.ai)

## Use

```bash
# Auto-loaded via s2-agent's run-dir manifest
export ZAI_API_KEY=...
pi -e bun-apps/s2-agent-ext-zai-mcp
```

## Cross-reference

- [`bun-apps/s2-agent/run-dir/manifest.json`](../s2-agent/run-dir/manifest.json) — auto-load configuration
